import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthStore } from '../../../core/services/auth-store';

/**
 * Where a permission guard sends someone who followed a link to a feature their
 * role does not include. Names the role so they know what to ask for, rather
 * than leaving them at a screen that answers 403 to everything.
 */
@Component({
  selector: 'ha-no-access',
  imports: [MatButtonModule, MatIconModule],
  template: `
    <div class="na">
      <mat-icon class="na__icon" aria-hidden="true">lock</mat-icon>
      <h1 class="na__title">You don't have access to that</h1>
      <p class="na__text">
        @if (auth.currentUser()?.roleName) {
          Your role is <strong>{{ auth.currentUser()?.roleName }}</strong>, which doesn't include
          this feature. Ask a super admin to adjust it under Roles.
        } @else {
          Your account doesn't include this feature. Ask a super admin to adjust your role.
        }
      </p>
      <a mat-flat-button color="primary" href="/admin/pages">
        <mat-icon aria-hidden="true">arrow_back</mat-icon>
        Back to the manual
      </a>
    </div>
  `,
  styles: `
    .na {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 64px 24px;
      text-align: center;

      &__icon {
        font-size: 44px;
        width: 44px;
        height: 44px;
        color: var(--mat-sys-on-surface-variant);
      }

      &__title {
        margin: 0;
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--mat-sys-on-surface);
      }

      &__text {
        margin: 0;
        max-width: 460px;
        font-size: 0.875rem;
        line-height: 1.6;
        color: var(--mat-sys-on-surface-variant);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NoAccess {
  readonly auth = inject(AuthStore);
}
