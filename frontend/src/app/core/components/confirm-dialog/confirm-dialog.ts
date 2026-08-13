import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

export interface ConfirmDialogData {
  title: string;
  /** Main sentence. Say what will happen, not "are you sure".  */
  message: string;
  /** Secondary line — used to explain that the item is recoverable. */
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for anything that cannot be undone. */
  destructive?: boolean;
  icon?: string;
}

/**
 * One confirmation dialog for the whole admin.
 *
 * Deliberately not `window.confirm`: it cannot say what recovery is available,
 * and "OK / Cancel" gives no clue which one destroys something. Here the button
 * names the action and the note tells the user whether it is reversible.
 */
@Component({
  selector: 'ha-confirm-dialog',
  imports: [MatButtonModule, MatIconModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title class="cd-title">
      <mat-icon [class.cd-icon--danger]="data.destructive" aria-hidden="true">
        {{ data.icon ?? (data.destructive ? 'warning_amber' : 'delete_outline') }}
      </mat-icon>
      {{ data.title }}
    </h2>

    <mat-dialog-content>
      <p class="cd-message">{{ data.message }}</p>
      @if (data.note) {
        <p class="cd-note">
          <mat-icon aria-hidden="true">{{ data.destructive ? 'error_outline' : 'restore_from_trash' }}</mat-icon>
          <span>{{ data.note }}</span>
        </p>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-stroked-button (click)="ref.close(false)">
        {{ data.cancelLabel ?? 'Cancel' }}
      </button>
      <button
        mat-flat-button
        [color]="data.destructive ? 'warn' : 'primary'"
        [class.cd-confirm--danger]="data.destructive"
        cdkFocusInitial
        (click)="ref.close(true)"
      >
        {{ data.confirmLabel ?? 'Delete' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .cd-title {
      display: flex;
      align-items: center;
      gap: 8px;

      mat-icon { color: var(--mat-sys-primary); }
    }

    .cd-icon--danger { color: var(--mat-sys-error) !important; }

    .cd-message {
      margin: 0;
      font-size: 0.9rem;
      line-height: 1.6;
      color: var(--mat-sys-on-surface);
    }

    .cd-note {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin: 12px 0 0;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 0.8125rem;
      line-height: 1.5;
      color: var(--mat-sys-on-surface-variant);
      background: var(--mat-sys-surface-container);
      border: 1px solid var(--mat-sys-outline-variant);

      mat-icon { flex: none; font-size: 18px; width: 18px; height: 18px; }
    }

    // Material has no built-in "warn" palette here, so the danger state is
    // painted explicitly rather than left looking like a normal action.
    .cd-confirm--danger {
      background: var(--mat-sys-error) !important;
      color: var(--mat-sys-on-error) !important;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmDialog {
  readonly ref = inject<MatDialogRef<ConfirmDialog, boolean>>(MatDialogRef);
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
