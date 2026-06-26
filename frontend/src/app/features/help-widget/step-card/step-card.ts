import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { renderStepMarkdown } from '../../../core/utils/step-markdown';
import type { TutorialStep } from '../../../core/models/page';

@Component({
  selector: 'ha-step-card',
  imports: [],
  templateUrl: './step-card.html',
  styleUrl: './step-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StepCard {
  readonly step = input.required<TutorialStep>();

  // Step content can originate from AI/scraped sources, so it is untrusted.
  // We return a plain string and let Angular's [innerHTML] sanitizer strip any
  // <script>/event handlers/javascript: URLs while keeping safe formatting —
  // never bypassSecurityTrustHtml (which would allow token-stealing XSS).
  readonly bodyHtml = computed(() =>
    renderStepMarkdown(this.step().instructionsMd, this.step().title),
  );
}
