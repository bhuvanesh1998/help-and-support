import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HelpWidget } from './features/help-widget/help-widget';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'ha-root',
  imports: [RouterOutlet, HelpWidget],
  template: `
    <router-outlet />
    <ha-help-widget />
  `,
  styles: [`
    :host { display: block; height: 100%; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  // Instantiate the theme service at the root so the saved mode + palette are
  // applied app-wide on every entry point — including a direct tutorial link
  // that never passes through the landing page or admin layout.
  private readonly theme = inject(ThemeService);
}
