import type { BasesAllOptions } from "obsidian";
import {
	DEFAULT_INDEX_PROPERTY,
	INDEX_PROPERTY_OPTION,
	SORT_DIRECTION_OPTION,
	UNINDEXED_PLACEMENT_OPTION,
} from "./order";

/** Options shown at the top of the Bases view configuration. */
export function viewOptions(): BasesAllOptions[] {
	return [
		{
			type: "text",
			key: INDEX_PROPERTY_OPTION,
			displayName: "Index property",
			default: DEFAULT_INDEX_PROPERTY,
			placeholder: DEFAULT_INDEX_PROPERTY,
		},
		{
			type: "dropdown",
			key: SORT_DIRECTION_OPTION,
			displayName: "Sort direction",
			default: "asc",
			options: {
				asc: "Ascending",
				desc: "Descending",
			},
		},
		{
			type: "dropdown",
			key: UNINDEXED_PLACEMENT_OPTION,
			displayName: "Unindexed notes",
			default: "after",
			options: {
				after: "After indexed",
				before: "Before indexed",
			},
		},
	];
}
