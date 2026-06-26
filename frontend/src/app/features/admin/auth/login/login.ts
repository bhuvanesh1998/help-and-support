import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import { ThemeService } from '../../../../core/services/theme.service';

@Component({
  selector: 'ha-login',
  imports: [
    FormsModule, RouterLink,
    MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatTooltipModule,
  ],
  templateUrl: './login.html',
  styleUrl: './login.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Login {
  private readonly api  = inject(AdminApiService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  readonly theme = inject(ThemeService);

  email        = '';
  password     = '';
  hidePassword = signal(true);
  loading      = signal(false);
  error        = signal('');

  submit(): void {
    if (!this.email || !this.password) return;
    this.loading.set(true);
    this.error.set('');

    this.api.login(this.email, this.password).subscribe({
      next: res => {
        this.auth.setToken(res.accessToken);
        this.api.me().subscribe({
          next: me => {
            this.auth.login(res.accessToken, res.refreshToken, me.user);
            void this.router.navigate(['/admin/pages']);
          },
          error: () => {
            this.auth.logout();
            this.loading.set(false);
            this.error.set('Login succeeded but failed to load profile.');
          },
        });
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Invalid email or password.');
      },
    });
  }
}
