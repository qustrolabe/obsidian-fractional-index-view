import type { BasesAllOptions } from "obsidian";
import { DEFAULT_INDEX_PROPERTY, INDEX_PROPERTY_OPTION } from "./order";

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
	];
}
