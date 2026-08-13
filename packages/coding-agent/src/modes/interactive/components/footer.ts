import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";
import { theme } from "../theme/theme.js";

/**
 * Footer component for the prime brand TUI.
 *
 * Renders nothing by default — token counters, cost, model name, cwd, and context %
 * are intentionally hidden. The setters and invalidate/dispose hooks are kept so the
 * existing call sites in interactive-mode keep working without modification, and so
 * `/usage` can expose telemetry without re-plumbing. The only visible content is the
 * subscription label shown while the current model runs on subscription OAuth
 * credentials.
 */
export class FooterComponent implements Component {
	private subscriptionLabel: string | undefined;

	constructor(private footerData: ReadonlyFooterDataProvider) {
		void this.footerData;
	}

	/**
	 * Set the subscription label rendered in the footer. `undefined` hides it.
	 */
	setSubscriptionLabel(label: string | undefined): void {
		this.subscriptionLabel = label;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// no-op while the footer is empty
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		// Footer is intentionally empty in the prime brand TUI. Telemetry (cost, tokens, model,
		// cwd, context %) is hidden by default; bring it back via /usage when needed. The only
		// exception is the subscription label, rendered as a single muted line.
		if (this.subscriptionLabel === undefined) {
			return [];
		}
		const label = truncateToWidth(this.subscriptionLabel, Math.max(1, width), "");
		return [theme.fg("muted", label)];
	}
}
