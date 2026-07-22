import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { clearToken, ensureToken } from '../services/token';

/**
 * Attach the dashboard token as `Authorization: Bearer <token>` to every API
 * request. On a 401 the stored token is wrong or was rotated, so we clear it —
 * the next request then re-prompts via ensureToken().
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = ensureToken();
  const authReq = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401) clearToken();
      return throwError(() => err);
    })
  );
};
