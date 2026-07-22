# Deploying on Oracle Cloud (Ubuntu, always-on)

Runbook for an Ubuntu Oracle Cloud Infrastructure (OCI) compute instance
(e.g. Ampere A1, 4 OCPU / 24 GB). Brings up Postgres + the telemetry server +
the dashboard as containers that restart on reboot and stay up until you stop
them.

> Everything runs as three Docker containers via `docker compose`. Only the
> dashboard (port 80) is exposed; the server and database stay on the internal
> Docker network.

---

## 1. Install Docker on the server

SSH in (`ssh ubuntu@<public-ip>`), then:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
# Docker Engine + compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER        # run docker without sudo
newgrp docker                        # apply the group in this shell
sudo systemctl enable docker         # start Docker on every boot  ← "always on"
docker compose version               # sanity check
```

## 2. Get the code onto the server

**Option A — from your laptop over rsync** (no GitHub needed). Run this on the
**laptop**, from the repo root:

```bash
rsync -av --exclude node_modules --exclude dist --exclude .angular --exclude .git \
  ./ ubuntu@<public-ip>:/home/ubuntu/telemetry/
```

**Option B — via GitHub.** Push the repo (see the commit already made), then on
the server: `git clone <your-repo-url> telemetry`.

## 3. Configure secrets

On the server, in the repo root, create a `.env` (compose reads it automatically):

```bash
cd ~/telemetry
cat > .env <<EOF
POSTGRES_PASSWORD=change-me-to-a-long-random-string
# REQUIRED — dashboard access token. Without it, all read/admin endpoints and
# the WebSocket fail closed (HTTP 503). Generate a strong one:
DASHBOARD_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" 2>/dev/null || openssl rand -base64 32)
# Optional AI usage workers (leave blank to disable):
ANTHROPIC_ADMIN_KEY=
GEMINI_BILLING_TABLE=
EOF
cat .env    # copy the DASHBOARD_TOKEN value — you'll paste it into the dashboard once
```

The dashboard prompts for this token on first load and remembers it (localStorage).

## 4. Launch

```bash
docker compose up -d --build      # builds images, starts in the background
docker compose ps                 # all three should be "running"/"healthy"
curl -s localhost/healthz         # {"status":"ok","db":"up",...}
```

`restart: unless-stopped` + `systemctl enable docker` means the stack comes back
by itself after a reboot and keeps running until you `docker compose down`.

---

## 5. How to access it — pick one

### Recommended: Tailscale (private, no domain, no firewall changes)

Nothing is exposed to the public internet; only your own devices reach it.

```bash
# On the server:
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4                    # note the 100.x.y.z address
```

Install Tailscale on your laptop too (same account), then browse to
**`http://<server-100.x.y.z>`**. Your agents also point at this address. Because
Tailscale tunnels over WireGuard, you do **not** need to open port 80 in OCI or
in the host firewall — leave them closed.

### Alternative: public IP (open port 80)

Two firewalls must both allow the port:

1. **OCI console:** Networking → your VCN → Security Lists (or the instance's
   NSG) → add an **Ingress** rule: Source `0.0.0.0/0` (or just your home IP for
   safety), IP Protocol TCP, Destination port **80**.
2. **On the Ubuntu instance** (its default iptables only allows SSH):
   ```bash
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   sudo netfilter-persistent save     # persist across reboots
   ```

Then browse to `http://<public-ip>`.

> ⚠️ Read/admin endpoints and the WebSocket are gated by `DASHBOARD_TOKEN`
> (set in step 3) — without the token they return 401, and if the token is
> unset they fail closed with 503. That secret is now the only thing between
> the public internet and your data, so on a public IP: use a long random
> token, always serve over **HTTPS** (step 8) so it isn't sent in the clear,
> and prefer Tailscale or an OCI rule limited to your own IP anyway. Note the
> token is not per-user and has no audit trail; treat a leak as full access.

---

## 6. Register resources & connect agents

From your laptop (or the server), against whichever base URL you chose:

```bash
BASE=http://<server-tailscale-or-public-ip>
curl -s $BASE/api/resources -H 'content-type: application/json' \
  -d '{"name":"MacBook Air","type":"compute","interval_seconds":15}'
# → copy the returned "api_key"
```

Then on your **MacBook**, fill in `agents/macos/config.json`
(`endpoint` = `$BASE`, `apiKey` = the key) and run `agents/macos/install.sh`.
Do the same on Windows with `agents/windows/`.

## 7. (Optional) Monitor the Oracle server itself

Register an `api_key` for it, then run the bundled host agent on the box:

```bash
sudo apt-get install -y nodejs        # or use the node from the docker host
sudo mkdir -p /etc/telemetry-agent
# put {"endpoint":"http://localhost","apiKey":"tk_...","intervalSeconds":15,
#      "bufferFile":"/var/lib/telemetry-agent/buffer.ndjson"} there
sudo ./agents/oracle/install.sh       # installs the systemd service
```

(`endpoint` is `http://localhost` — port 80 — because the dashboard's nginx
proxies `/api/ingest` to the server container.)

---

## 8. Day-2 operations

```bash
docker compose logs -f server         # follow server logs
docker compose logs -f web            # nginx / dashboard
docker compose pull && docker compose up -d --build   # redeploy after changes
docker compose down                   # stop everything (until you bring it up again)
```

**Backups:** the database lives in the `pgdata` Docker volume. Snapshot it with:

```bash
docker compose exec postgres pg_dump -U telemetry telemetry > backup-$(date +%F).sql
```

**Adding HTTPS later:** either put Caddy in front (automatic certs) or use
`deploy/nginx.conf` with certbot on the host, pointing a domain's A record at the
public IP. With Tailscale you can instead run `tailscale cert` for HTTPS on the
tailnet name.
