import type { Usage } from "@z-agent/agent";
import { emptyUsage } from "@z-agent/ai";
import type { LabeledSegment } from "@z-agent/tui";
import { fitLabeledSegments } from "@z-agent/tui";
import { formatCompactContext } from "./model-settings.ts";

export interface StatusSegment {
	id: string;
	order: number;
	priority: number;
	required?: boolean;
	render: () => string | undefined;
}

export function safeSegmentText(segment: StatusSegment): string | undefined {
	try {
		const text = segment.render()?.trim();
		return text && text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

export function composeStatusLine(segments: readonly StatusSegment[], maxWidth: number): string {
	const labeled: LabeledSegment[] = segments
		.map((segment) => ({
			id: segment.id,
			text: safeSegmentText(segment) ?? "",
			priority: segment.priority,
			required: segment.required,
			order: segment.order,
		}))
		.filter((segment) => segment.text.length > 0)
		.sort((left, right) => left.order - right.order);
	return fitLabeledSegments(labeled, maxWidth, " · ");
}

export function accumulateAssistantUsage(usage: Usage | undefined, next: Usage | undefined): Usage {
	const base = usage ?? emptyUsage();
	if (!next) {
		return base;
	}
	return {
		input: base.input + next.input,
		output: base.output + next.output,
		cacheRead: base.cacheRead + next.cacheRead,
		cacheWrite: base.cacheWrite + next.cacheWrite,
		totalTokens: base.totalTokens + next.totalTokens,
		cost: {
			input: base.cost.input + next.cost.input,
			output: base.cost.output + next.cost.output,
			cacheRead: base.cost.cacheRead + next.cost.cacheRead,
			cacheWrite: base.cost.cacheWrite + next.cost.cacheWrite,
			total: base.cost.total + next.cost.total,
		},
		...(next.reasoning !== undefined || base.reasoning !== undefined
			? { reasoning: (base.reasoning ?? 0) + (next.reasoning ?? 0) }
			: {}),
	};
}

export function formatUsageOccupancy(usage: Usage, contextWindow?: number): string {
	const used = usage.totalTokens > 0 ? usage.totalTokens : usage.input + usage.output;
	if (contextWindow && contextWindow > 0) {
		const pct = Math.min(100, Math.round((used / contextWindow) * 100));
		return `${formatCompactContext(used)}/${formatCompactContext(contextWindow)} ${pct}%`;
	}
	return used > 0 ? formatCompactContext(used) : "0";
}
