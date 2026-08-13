import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialog, type ConfirmDialogData } from '../components/confirm-dialog/confirm-dialog';

/** Days a deleted item stays restorable. Mirrors the server's retention. */
export const TRASH_RETENTION_DAYS = 30;

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly dialog = inject(MatDialog);

  async ask(data: ConfirmDialogData): Promise<boolean> {
    const ref = this.dialog.open(ConfirmDialog, {
      data,
      width: '460px',
      autoFocus: 'dialog',
      restoreFocus: true,
    });
    return (await firstValueFrom(ref.afterClosed())) === true;
  }

  /**
   * The standard "this goes to the trash" confirmation.
   *
   * One place, so every delete in the admin promises the same thing — a screen
   * that quietly hard-deletes while another offers recovery is worse than either
   * behaviour on its own.
   */
  confirmMoveToTrash(what: string, detail?: string): Promise<boolean> {
    return this.ask({
      title: `Move ${what} to Trash?`,
      message: detail
        ? `${detail} It will be moved to Trash, not deleted immediately.`
        : `It will be moved to Trash, not deleted immediately.`,
      note: `You can restore it from Trash for ${TRASH_RETENTION_DAYS} days, after which it is deleted permanently.`,
      confirmLabel: 'Move to Trash',
      icon: 'delete_outline',
    });
  }

  /** For the permanent delete inside the trash itself. */
  confirmPermanentDelete(what: string): Promise<boolean> {
    return this.ask({
      title: `Delete ${what} permanently?`,
      message: `${what} and its files will be removed for good.`,
      note: 'This cannot be undone.',
      confirmLabel: 'Delete permanently',
      destructive: true,
    });
  }
}
