import { Routes } from '@angular/router';
import { OverviewComponent } from './components/overview.component';
import { ResourceDetailComponent } from './components/resource-detail.component';
import { RegisterComponent } from './components/register.component';

export const routes: Routes = [
  { path: '', component: OverviewComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'resource/:id', component: ResourceDetailComponent },
  { path: '**', redirectTo: '' },
];
