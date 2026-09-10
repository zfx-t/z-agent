import { clip, visibleWidth } from "./text.ts";

export interface LabeledSegment {
	id: string;
	text: string;
	priority: number;
	required?: boolean;
}

/** Drop lowest-priority optional segments until the line fits. Required segments stay. */
export function fitLabeledSegments(segments: readonly LabeledSegment[], maxWidth: number, separator = "  "): string {
	const items = segments.filter((segment) => segment.text.trim().length > 0).map((segment) => ({ ...segment }));
	const join = (list: LabeledSegment[]): string => list.map((segment) => segment.text).join(separator);
	let current = items;
	while (current.length > 0 && visibleWidth(join(current)) > Math.max(0, maxWidth)) {
		const droppable = current.filter((segment) => !segment.required);
		if (droppable.length === 0) {
			break;
		}
		const lowest = droppable.reduce((weakest, segment) => (segment.priority < weakest.priority ? segment : weakest));
		current = current.filter((segment) => segment.id !== lowest.id);
	}
	const line = join(current);
	return clip(line, Math.max(0, maxWidth));
}
