import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AdminApiService } from '../../../../core/services/admin-api';
import { AuthStore } from '../../../../core/services/auth-store';
import type { AdminUser } from '../../../../core/models/admin';

@Component({
  selector: 'ha-users-list',
  imports: [
    FormsModule, DatePipe,
    MatButtonModule, MatIconModule, MatSelectModule,
    MatSlideToggleModule, MatSnackBarModule, MatTooltipModule,
  ],
  templateUrl: './users-list.html',
  styleUrl: './users-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsersList implements OnInit {
  private readonly api   = inject(AdminApiService);
  private readonly snack = inject(MatSnackBar);
  readonly auth          = inject(AuthStore);

  readonly loading  = signal(true);
  readonly saving   = signal(false);
  readonly users    = signal<AdminUser[]>([]);
  readonly showForm = signal(false);
  readonly search   = signal('');

  readonly filtered = computed(() => {
    const q   = this.search().toLowerCase().trim();
    const all = this.users();
    if (!q) return all;
    return all.filter(
      u => u.email.toLowerCase().includes(q) || u.role.toLowerCase().includes(q),
    );
  });

  newEmail    = '';
  newPassword = '';
  newRole: 'SUPER_ADMIN' | 'ADMIN' = 'ADMIN';

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.api.listUsers().subscribe({
      next:  res => { this.users.set(res.users); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  openForm(): void {
    this.newEmail    = '';
    this.newPassword = '';
    this.newRole     = 'ADMIN';
    this.showForm.set(true);
  }

  cancelForm(): void { this.showForm.set(false); }

  createUser(): void {
    this.saving.set(true);
    this.api.createUser({ email: this.newEmail, password: this.newPassword, role: this.newRole }).subscribe({
      next: () => {
        this.saving.set(false);
        this.showForm.set(false);
        this.snack.open('User created', undefined, { duration: 2500 });
        this.load();
      },
      error: err => {
        this.saving.set(false);
        this.snack.open(err.error?.error?.message ?? 'Create failed', 'OK', { duration: 4000 });
      },
    });
  }

  toggleActive(user: AdminUser): void {
    this.api.updateUser(user.id, { isActive: !user.isActive }).subscribe({
      next:  () => { this.snack.open(`User ${user.isActive ? 'deactivated' : 'activated'}`, undefined, { duration: 2000 }); this.load(); },
      error: () => this.snack.open('Update failed', 'OK', { duration: 3000 }),
    });
  }

  deleteUser(user: AdminUser): void {
    if (user.email === this.auth.currentUser()?.email) {
      this.snack.open('Cannot delete your own account', 'OK', { duration: 3000 });
      return;
    }
    if (!confirm(`Delete "${user.email}"?`)) return;
    this.api.deleteUser(user.id).subscribe({
      next:  () => { this.snack.open('User deleted', undefined, { duration: 2000 }); this.load(); },
      error: () => this.snack.open('Delete failed', 'OK', { duration: 3000 }),
    });
  }

  changeRole(user: AdminUser, role: string): void {
    this.api.updateUser(user.id, { role }).subscribe({
      next:  () => { this.snack.open('Role updated', undefined, { duration: 2000 }); this.load(); },
      error: () => this.snack.open('Update failed', 'OK', { duration: 3000 }),
    });
  }

  isSelf(user: AdminUser): boolean {
    return user.email === this.auth.currentUser()?.email;
  }
}
