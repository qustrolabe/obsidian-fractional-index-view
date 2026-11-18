import {
	BasesView,
	Modal,
	Notice,
	setIcon,
	type App,
	type BasesEntry,
	type BasesEntryGroup,
	type BasesPropertyId,
	type BasesViewConfig,
	type QueryController,
	type TFile,
} from "obsidian";
import {
	INDEX_PROPERTY_OPTION,
	SORT_DIRECTION_OPTION,
	displayRows,
	indexKey,
	indexProperty,
	planBalance,
	planDisplayMove,
	planDrop,
	planEdgeMove,
	sameIndexValue,
	sortDirection,
	type Edge,
	type IndexWrite,
	type OrderDirection,
	type Row,
} from "./order";

const NOTE_COLUMN = "file.name" as BasesPropertyId;
const INDEX_COLUMN_SEEDED_OPTION = "seededIndexProperty";
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 4000;
const INDEX_COLUMN_WIDTH = 152;

interface DisplayRow {
	entry: BasesEntry;
	row: Row;
}

interface RenderContext {
	property: string;
	indexId: BasesPropertyId;
	columns: BasesPropertyId[];
	widths: Map<BasesPropertyId, number>;
	direction: OrderDirection;
	ordinalWidth: number;
}

function clampColumnWidth(width: number): number {
	return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

export class FractionalIndexView extends BasesView {
	type = "fractional-index-view";

	private readonly root: HTMLElement;
	private busy = false;
	private seeding = false;
	private readonly seedAttempted = new Set<string>();
	private dragged: { id: string; group: number } | null = null;
	private draggedColumn: BasesPropertyId | null = null;
	private resizingColumn: BasesPropertyId | null = null;
	private fallbackOrder: BasesPropertyId[] | null = null;
	private effectiveGroups: BasesEntryGroup[] = [];
	private renderQueued = false;

	constructor(controller: QueryController, container: HTMLElement) {
		super(controller);
		container.addClass("fiv-bases-view");
		this.root = container.createDiv({ cls: "fiv-view" });
	}

	onunload(): void {
		this.root.empty();
	}

	onDataUpdated(): void {
		this.queueRender();
	}

	private queueRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		queueMicrotask(() => {
			this.renderQueued = false;
			this.render();
		});
	}

	private render(): void {
		if (this.busy || this.seeding || !this.data) return;

		const active = this.root.doc.activeElement;
		const focused = active && this.root.contains(active) ? this.focusKey(active) : null;
		const { scrollTop, scrollLeft } = this.root;

		this.root.empty();

		let property: string;
		try {
			property = indexProperty(this.config.get(INDEX_PROPERTY_OPTION));
		} catch (error) {
			this.root.createEl("p", { cls: "fiv-error", text: errorMessage(error) });
			return;
		}

		this.seeding = true;
		try {
			this.seedIndexColumn(property);
		} finally {
			this.seeding = false;
		}
		const direction = sortDirection(this.config.get(SORT_DIRECTION_OPTION));
		const indexId = `note.${property}` as BasesPropertyId;
		const columns = this.displayColumns(indexId);
		const widths = this.columnWidths(columns, indexId);

		const toolbar = this.root.createDiv({ cls: "fiv-toolbar" });
		this.renderIndexPropertyControl(toolbar, property);
		this.renderDirection(toolbar, direction);
		this.renderRebalance(toolbar, property, direction);
		toolbar.createSpan({
			cls: "fiv-toolbar-count",
			text: `${this.data.data.length} item${this.data.data.length === 1 ? "" : "s"}`,
		});

		if (this.data.data.length === 0) {
			this.root.createEl("p", {
				cls: "fiv-empty",
				text: "No notes match this base. Change its filters to show notes.",
			});
			this.root.scrollTop = scrollTop;
			this.root.scrollLeft = scrollLeft;
			return;
		}

		const context: RenderContext = {
			property,
			indexId,
			columns,
			widths,
			direction,
			ordinalWidth: Math.max(1, String(this.data.data.length).length),
		};
		let groups = this.data.groupedData;
		const isGrouped = groups.length > 1 || (groups.length === 1 && groups[0]?.hasKey() === true);
		if (isGrouped) {
			this.renderWarning(
				"Grouping is not supported by the fractional index view. Showing all notes in one list; remove grouping in the bases view settings.",
			);
			const merged = {
				hasKey: () => false,
				key: undefined,
				entries: groups.flatMap((group) => group.entries),
			} as BasesEntryGroup;
			groups = [merged];
		}
		this.effectiveGroups = groups;
		groups.forEach((group, groupIndex) => {
			this.renderGroup(groupIndex, group, context);
		});
		this.fitControlsColumns();

		if (focused) {
			const target = Array.from(
				this.root.querySelectorAll<HTMLElement>("button, input[data-fiv-focus]"),
			).find((element) => this.focusKey(element) === focused);
			target?.focus();
			if (target instanceof HTMLInputElement) {
				const end = target.value.length;
				try {
					target.setSelectionRange(end, end);
				} catch {
					// Some input types do not support selection ranges.
				}
			}
		}

		this.root.scrollTop = scrollTop;
		this.root.scrollLeft = scrollLeft;
	}

	private focusKey(element: Element): string | null {
		return element.getAttribute("data-fiv-focus") ?? element.getAttribute("aria-label");
	}

	/**
	 * Size the controls column to its buttons. A fixed pixel width breaks when
	 * the app font is larger, so measure the rendered cells instead.
	 */
	private fitControlsColumns(): void {
		const cells = Array.from(
			this.root.querySelectorAll<HTMLTableCellElement>("td.fiv-controls"),
		);
		if (cells.length === 0) return;

		// Fallback for a view that has not been laid out yet: three 24px icon
		// buttons, their margins, the cell padding and the leading border.
		let width = Math.ceil(3 * 24 + 6 + 4 + 1);
		for (const cell of cells) {
			const style = this.root.win.getComputedStyle(cell);
			const border =
				parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
			width = Math.max(width, Math.ceil(cell.scrollWidth + border));
		}

		this.root
			.querySelectorAll<HTMLTableColElement>("col.fiv-controls-col")
			.forEach((col) => {
				col.style.width = `${width}px`;
			});
	}

	private renderGroup(groupIndex: number, group: BasesEntryGroup, context: RenderContext): void {
		const { property, direction, indexId, columns, widths, ordinalWidth } = context;
		const section = this.root.createDiv({ cls: "fiv-group" });

		if (group.hasKey()) {
			const header = section.createDiv({ cls: "fiv-group-header" });
			if (group.key) {
				try {
					group.key.renderTo(header, this.app.renderContext);
				} catch {
					header.setText(group.key.toString());
				}
			} else {
				header.setText("No value");
			}
			header.createSpan({
				cls: "fiv-group-count",
				text: String(group.entries.length),
			});
		}

		let rows: Row[];
		let byId: Map<string, BasesEntry>;
		let movable: Row[];
		let display: DisplayRow[];
		try {
			const notes = group.entries.filter((entry) => entry.file.extension === "md");
			byId = new Map(group.entries.map((entry) => [entry.file.path, entry]));
			rows = this.buildRows(notes, property);
			movable = displayRows(rows, direction);
			const attachments = group.entries
				.filter((entry) => entry.file.extension !== "md")
				.sort((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
			display = [
				...movable.flatMap((row) => {
					const entry = byId.get(row.id);
					return entry ? [{ entry, row }] : [];
				}),
				...attachments.map((entry) => ({
					entry,
					row: { id: entry.file.path, index: undefined },
				})),
			];
		} catch (error) {
			section.createEl("p", { cls: "fiv-error", text: errorMessage(error) });
			return;
		}

		if (display.length === 0) {
			section.createEl("p", { cls: "fiv-empty", text: "No notes in this group." });
			return;
		}

		const table = section.createEl("table", { cls: "fiv-table" });
		const colgroup = table.createEl("colgroup");
		colgroup.createEl("col", { cls: "fiv-controls-col" });
		const columnCols = new Map<BasesPropertyId, HTMLTableColElement>();
		for (const column of columns) {
			const col = colgroup.createEl("col");
			col.style.width = `${widths.get(column) ?? MIN_COLUMN_WIDTH}px`;
			columnCols.set(column, col);
		}
		colgroup.createEl("col", { cls: "fiv-filler-col" });

		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", {
			cls: "fiv-controls fiv-head-controls",
			attr: { scope: "col", "aria-label": "Row controls" },
		});
		for (const column of columns) {
			this.renderColumnHeader(head, column, context, columnCols.get(column));
		}
		head.createEl("th", { cls: "fiv-filler", attr: { "aria-hidden": "true" } });

		const tailStart = (() => {
			const index = movable.findIndex((candidate) => indexKey(candidate.index) === null);
			return index === -1 ? movable.length : index;
		})();

		const body = table.createEl("tbody");
		display.forEach(({ entry, row }, position) => {
			const movableIndex = movable.findIndex((candidate) => candidate.id === row.id);
			const indexed = indexKey(row.index) !== null;
			const tr = body.createEl("tr", { attr: { "data-path": row.id } });
			this.renderControls(
				tr,
				groupIndex,
				row,
				entry,
				movable,
				movableIndex,
				tailStart,
				property,
				direction,
				indexed,
			);

			for (const column of columns) {
				if (column === indexId) this.renderIndexCell(tr, row, position, ordinalWidth);
				else if (column === NOTE_COLUMN) this.renderNoteCell(tr, entry);
				else this.renderValueCell(tr, entry, column);
			}
			tr.createEl("td", { cls: "fiv-filler", attr: { "aria-hidden": "true" } });

			if (movableIndex >= 0 && entry.file.extension === "md") {
				tr.addEventListener("dragover", (event) => {
					if (!this.dragged || this.dragged.group !== groupIndex || this.busy) return;
					event.preventDefault();
					const below = this.isBelow(tr, event);
					this.clearDropTargets();
					tr.addClass(below ? "fiv-drop-below" : "fiv-drop-above");
					if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
				});
				tr.addEventListener("dragleave", (event) => {
					if (!event.relatedTarget || !tr.contains(event.relatedTarget as Node)) {
						tr.removeClass("fiv-drop-above");
						tr.removeClass("fiv-drop-below");
					}
				});
				tr.addEventListener("drop", (event) => {
					event.preventDefault();
					const drag = this.dragged;
					this.dragged = null;
					this.clearDropTargets();
					if (!drag || drag.group !== groupIndex || this.busy) return;
					const below = this.isBelow(tr, event);
					const beforeDisplay = below ? movable[movableIndex + 1]?.id ?? null : row.id;
					if (drag.id === beforeDisplay) return;
					void this.moveDrop(groupIndex, drag.id, beforeDisplay, property, direction);
				});
			}
		});
	}

	private renderControls(
		tr: HTMLTableRowElement,
		groupIndex: number,
		row: Row,
		entry: BasesEntry,
		movable: Row[],
		movableIndex: number,
		tailStart: number,
		property: string,
		direction: OrderDirection,
		indexed: boolean,
	): void {
		const cell = tr.createEl("td", { cls: "fiv-controls" });
		if (entry.file.extension !== "md" || movableIndex < 0) {
			cell.createSpan({ cls: "fiv-attachment", text: "—" });
			return;
		}

		const name = entry.file.basename;
		const isFirst = movableIndex <= 0;
		const isLastIndexed = movableIndex >= tailStart - 1;

		const handle = cell.createEl("button", {
			cls: "fiv-handle clickable-icon",
			attr: {
				type: "button",
				draggable: "true",
				"aria-label": `Drag ${name}`,
				title: "Drag to reorder",
			},
		});
		setIcon(handle, "grip-vertical");
		handle.addEventListener("dragstart", (event) => {
			if (this.busy) {
				event.preventDefault();
				return;
			}
			this.dragged = { id: row.id, group: groupIndex };
			tr.addClass("fiv-dragging");
			event.dataTransfer?.setData("text/plain", row.id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		});
		handle.addEventListener("dragend", () => {
			this.dragged = null;
			tr.removeClass("fiv-dragging");
			this.clearDropTargets();
		});

		if (indexed) {
			const up = cell.createEl("button", {
				cls: "fiv-move clickable-icon",
				attr: {
					type: "button",
					"aria-label": `Move ${name} up one`,
					title: "Move up one",
				},
			});
			setIcon(up, "chevron-up");
			up.disabled = isFirst || this.busy;
			up.addEventListener("click", () => {
				const before = movable[movableIndex - 1];
				if (before) void this.moveDrop(groupIndex, row.id, before.id, property, direction);
			});

			const down = cell.createEl("button", {
				cls: "fiv-move clickable-icon",
				attr: {
					type: "button",
					"aria-label": `Move ${name} down one`,
					title: "Move down one",
				},
			});
			setIcon(down, "chevron-down");
			down.disabled = isLastIndexed || this.busy;
			down.addEventListener("click", () => {
				const beforeDisplay = movable[movableIndex + 2]?.id ?? null;
				void this.moveDrop(groupIndex, row.id, beforeDisplay, property, direction);
			});
			return;
		}

		const top = cell.createEl("button", {
			cls: "fiv-move clickable-icon",
			attr: {
				type: "button",
				"aria-label": `Move ${name} to the top of the indexed notes`,
				title: "Move to top of indexed notes",
			},
		});
		setIcon(top, "chevrons-up");
		top.addEventListener("click", () => {
			void this.moveToEdge(groupIndex, row.id, "top", property, direction);
		});

		const bottom = cell.createEl("button", {
			cls: "fiv-move clickable-icon",
			attr: {
				type: "button",
				"aria-label": `Move ${name} to the bottom of the indexed notes`,
				title: "Move to bottom of indexed notes",
			},
		});
		setIcon(bottom, "chevrons-down");
		bottom.addEventListener("click", () => {
			void this.moveToEdge(groupIndex, row.id, "bottom", property, direction);
		});
	}

	private renderNoteCell(tr: HTMLTableRowElement, entry: BasesEntry): void {
		const cell = tr.createEl("td", { cls: "fiv-note" });
		const link = cell.createEl("a", {
			text: entry.file.basename,
			href: entry.file.path,
			cls: "internal-link",
			attr: { "data-href": entry.file.path },
		});
		link.addEventListener("mouseover", (event) => {
			this.app.workspace.trigger("hover-link", {
				event,
				source: this.type,
				hoverParent: this,
				targetEl: link,
				linktext: entry.file.path,
				sourcePath: "",
			});
		});
		link.addEventListener("click", (event) => {
			event.preventDefault();
			void this.app.workspace.openLinkText(
				entry.file.path,
				"",
				event.ctrlKey || event.metaKey,
			);
		});
	}

	private renderIndexCell(
		tr: HTMLTableRowElement,
		row: Row,
		position: number,
		ordinalWidth: number,
	): void {
		const cell = tr.createEl("td", { cls: "fiv-index" });
		const inner = cell.createDiv({ cls: "fiv-index-inner" });
		const key = indexKey(row.index);
		if (key === null) {
			inner.createSpan({ cls: "fiv-index-empty", text: "—" });
			return;
		}
		inner.createSpan({ cls: "fiv-index-key", text: key });
		const ordinal = String(position + 1).padStart(ordinalWidth, "0");
		inner.createSpan({
			cls: "fiv-index-order",
			text: `#${ordinal}`,
			attr: { title: `Position ${position + 1} in this group` },
		});
	}

	private renderValueCell(
		tr: HTMLTableRowElement,
		entry: BasesEntry,
		column: BasesPropertyId,
	): void {
		const cell = tr.createEl("td");
		const value = entry.getValue(column);
		if (!value) return;
		try {
			value.renderTo(cell, this.app.renderContext);
		} catch {
			cell.setText(value.toString());
		}
	}

	private currentOrder(): BasesPropertyId[] {
		return this.fallbackOrder ?? this.config.getOrder();
	}

	private displayColumns(indexId: BasesPropertyId): BasesPropertyId[] {
		const order = this.currentOrder().slice();
		if (!order.includes(NOTE_COLUMN)) order.unshift(NOTE_COLUMN);
		if (!this.indexColumnVisible(indexId)) {
			return order.filter((property) => property !== indexId);
		}
		if (order.includes(indexId)) return order;

		const next = order.filter((property) => property !== indexId);
		const noteIndex = next.indexOf(NOTE_COLUMN);
		next.splice(noteIndex < 0 ? 0 : noteIndex + 1, 0, indexId);
		return next;
	}

	private indexColumnVisible(indexId: BasesPropertyId): boolean {
		if (this.currentOrder().includes(indexId)) return true;
		return this.config.get(INDEX_COLUMN_SEEDED_OPTION) !== indexId;
	}

	private columnWidths(
		columns: BasesPropertyId[],
		indexId: BasesPropertyId,
	): Map<BasesPropertyId, number> {
		const custom = this.customColumnSizes();
		const widths = new Map<BasesPropertyId, number>();
		for (const column of columns) {
			widths.set(
				column,
				clampColumnWidth(custom[column] ?? this.estimateColumnWidth(column, indexId)),
			);
		}
		return widths;
	}

	private estimateColumnWidth(column: BasesPropertyId, indexId: BasesPropertyId): number {
		if (column === indexId) return INDEX_COLUMN_WIDTH;

		let chars = this.config.getDisplayName(column).length;
		for (const entry of this.data.data.slice(0, 100)) {
			let text: string;
			try {
				text =
					column === NOTE_COLUMN
						? entry.file.basename
						: (entry.getValue(column)?.toString() ?? "");
			} catch {
				continue;
			}
			for (const line of text.split("\n")) chars = Math.max(chars, line.length);
		}
		const estimate = Math.min(chars, 40) * 7.2 + 30;
		if (column === NOTE_COLUMN) return Math.max(estimate, 280);
		return estimate;
	}

	private customColumnSizes(): Record<string, number> {
		const raw = this.config.get("columnSize");
		const sizes: Record<string, number> = {};
		if (!raw || typeof raw !== "object") return sizes;
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				sizes[key] = value;
			}
		}
		return sizes;
	}

	private saveColumnSize(column: BasesPropertyId, width: number | null): void {
		const sizes = this.customColumnSizes();
		if (width === null) delete sizes[column];
		else sizes[column] = clampColumnWidth(width);
		try {
			this.config.set("columnSize", sizes);
		} catch (error) {
			new Notice(`Could not save the column width: ${errorMessage(error)}`);
		}
	}

	/**
	 * Native Bases reads the column order from a private field that
	 * `config.set("order", …)` does not update. Use Obsidian's own setter when it
	 * is present, and otherwise keep the order inside this view instance.
	 */
	private writeColumnOrder(order: BasesPropertyId[]): boolean {
		const config = this.config as BasesViewConfig & {
			setOrder?: (order: BasesPropertyId[]) => void;
		};
		try {
			if (typeof config.setOrder === "function") {
				config.setOrder(order);
			} else {
				this.fallbackOrder = order;
				this.config.set("order", order);
			}
			return true;
		} catch (error) {
			new Notice(`Could not save the column order: ${errorMessage(error)}`);
			return false;
		}
	}

	/**
	 * Put the index property into the native Properties list once, so that the
	 * menu shows it as selected and the user can move or hide the column.
	 */
	private seedIndexColumn(property: string): void {
		const indexId = `note.${property}` as BasesPropertyId;
		const order = this.currentOrder();
		if (order.includes(indexId)) {
			this.rememberSeededIndex(indexId);
			return;
		}
		if (this.config.get(INDEX_COLUMN_SEEDED_OPTION) === indexId) return;
		// Try once per view instance. If the Bases version rejects the write we
		// keep rendering the column locally instead of retrying on every update.
		if (this.seedAttempted.has(indexId)) return;
		this.seedAttempted.add(indexId);

		const noteIndex = order.indexOf(NOTE_COLUMN);
		const next = [...order];
		next.splice(noteIndex < 0 ? 0 : noteIndex + 1, 0, indexId);
		if (this.writeColumnOrder(next)) this.rememberSeededIndex(indexId);
	}

	private rememberSeededIndex(indexId: BasesPropertyId): void {
		if (this.config.get(INDEX_COLUMN_SEEDED_OPTION) === indexId) return;
		try {
			this.config.set(INDEX_COLUMN_SEEDED_OPTION, indexId);
		} catch {
			// The seeded marker only controls the automatic column insertion.
		}
	}

	private renderDirection(toolbar: HTMLElement, direction: OrderDirection): void {
		const ascending = direction === "asc";
		const button = toolbar.createEl("button", {
			cls: "fiv-direction",
			attr: {
				type: "button",
				"data-fiv-focus": "sort-direction",
				"aria-label": ascending
					? "Sort direction: ascending. Click to switch to descending."
					: "Sort direction: descending. Click to switch to ascending.",
				title: ascending ? "Switch to descending" : "Switch to ascending",
			},
		});
		setIcon(button, ascending ? "arrow-up" : "arrow-down");
		button.createSpan({
			cls: "fiv-direction-label",
			text: ascending ? "Ascending" : "Descending",
		});
		button.addEventListener("click", () => {
			this.setDirection(ascending ? "desc" : "asc");
		});
	}

	private setDirection(direction: OrderDirection): void {
		try {
			this.config.set(SORT_DIRECTION_OPTION, direction);
		} catch (error) {
			new Notice(`Could not save the sort direction: ${errorMessage(error)}`);
			return;
		}
		this.onDataUpdated();
	}

	private renderWarning(text: string): void {
		const warning = this.root.createDiv({ cls: "fiv-warning" });
		warning.createSpan({ cls: "fiv-warning-icon", attr: { "aria-hidden": "true" }, text: "!" });
		warning.createSpan({ cls: "fiv-warning-text", text });
	}

	private renderIndexPropertyControl(toolbar: HTMLElement, property: string): void {
		const wrap = toolbar.createDiv({ cls: "fiv-property" });
		wrap.createSpan({ cls: "fiv-property-label", text: "Index property" });
		const input = wrap.createEl("input", {
			cls: "fiv-property-input",
			attr: {
				type: "text",
				value: property,
				spellcheck: "false",
				"aria-label": "Index property",
				"data-fiv-focus": "index-property",
			},
		});
		const save = () => {
			const raw = input.value;
			let next: string;
			try {
				next = indexProperty(raw);
			} catch (error) {
				new Notice(errorMessage(error));
				input.value = property;
				return;
			}
			input.value = next;
			if (next === property) return;
			this.setIndexProperty(next);
		};
		input.addEventListener("change", save);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				save();
				input.blur();
			} else if (event.key === "Escape") {
				input.value = property;
				input.blur();
			}
		});
	}

	private setIndexProperty(property: string): void {
		try {
			this.config.set(INDEX_PROPERTY_OPTION, property);
		} catch (error) {
			new Notice(`Could not save the index property: ${errorMessage(error)}`);
			return;
		}
		this.onDataUpdated();
	}

	private renderRebalance(toolbar: HTMLElement, property: string, direction: OrderDirection): void {
		const button = toolbar.createEl("button", {
			cls: "fiv-rebalance",
			attr: {
				type: "button",
				"data-fiv-focus": "rebalance",
				"aria-label": "Rebalance indexed notes",
				title: "Rebalance indexed notes",
			},
		});
		setIcon(button, "scale");
		button.createSpan({ cls: "fiv-rebalance-label", text: "Rebalance" });
		button.addEventListener("click", () => {
			void this.rebalance(property, direction);
		});
	}

	private renderColumnHeader(
		head: HTMLTableRowElement,
		column: BasesPropertyId,
		context: RenderContext,
		col: HTMLTableColElement | undefined,
	): void {
		const { indexId, columns, widths } = context;
		const name = this.config.getDisplayName(column);
		const th = head.createEl("th", {
			cls: "fiv-col",
			attr: { scope: "col", "data-property": column },
		});

		const header = th.createDiv({ cls: "bases-table-header" });
		const label = header.createDiv({ cls: "bases-table-header-label" });
		label.createDiv({ cls: "bases-table-header-name", text: name });

		const resizer = th.createDiv({
			cls: "bases-table-header-resizer",
			attr: {
				role: "separator",
				"aria-orientation": "vertical",
				"aria-label": `Resize ${name} column`,
			},
		});
		resizer.title = "Drag to resize. Double-click to reset.";
		const width = widths.get(column) ?? MIN_COLUMN_WIDTH;
		resizer.addEventListener("pointerdown", (event) => {
			this.startColumnResize(event, col, column, width);
		});
		resizer.addEventListener("dblclick", (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.resetColumnSize(column, col, indexId);
		});

		th.draggable = true;
		th.addClass("fiv-col-draggable");
		th.title = `Drag to reorder ${name}`;
		th.addEventListener("dragstart", (event) => {
			if (this.busy || this.resizingColumn) {
				event.preventDefault();
				return;
			}
			this.draggedColumn = column;
			th.addClass("fiv-col-dragging");
			event.dataTransfer?.setData("text/plain", column);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		});
		th.addEventListener("dragend", () => {
			this.draggedColumn = null;
			th.removeClass("fiv-col-dragging");
			this.clearColumnDropTargets();
		});
		th.addEventListener("dragover", (event) => {
			if (!this.draggedColumn || this.draggedColumn === column || this.busy) return;
			event.preventDefault();
			this.clearColumnDropTargets();
			const rect = th.getBoundingClientRect();
			const after = event.clientX > rect.left + rect.width / 2;
			th.addClass(after ? "fiv-col-drop-after" : "fiv-col-drop-before");
			if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
		});
		th.addEventListener("dragleave", (event) => {
			if (!event.relatedTarget || !th.contains(event.relatedTarget as Node)) {
				th.removeClass("fiv-col-drop-before");
				th.removeClass("fiv-col-drop-after");
			}
		});
		th.addEventListener("drop", (event) => {
			event.preventDefault();
			const source = this.draggedColumn;
			this.draggedColumn = null;
			this.clearColumnDropTargets();
			if (!source || source === column || this.busy) return;
			const rect = th.getBoundingClientRect();
			this.moveColumn(columns, source, column, event.clientX > rect.left + rect.width / 2);
		});
	}

	private startColumnResize(
		event: PointerEvent,
		col: HTMLTableColElement | undefined,
		column: BasesPropertyId,
		startWidth: number,
	): void {
		if (event.button !== 0 || !col || event.detail > 1) return;
		event.preventDefault();
		event.stopPropagation();

		const resizer = event.currentTarget as HTMLElement;
		const startX = event.clientX;
		const controller = new AbortController();
		const { signal } = controller;
		let current = startWidth;
		let finished = false;
		this.resizingColumn = column;
		resizer.addClass("is-active");
		try {
			resizer.setPointerCapture(event.pointerId);
		} catch {
			// Pointer capture is not available in every environment.
		}

		const finish = (persist: boolean) => {
			if (finished) return;
			finished = true;
			controller.abort();
			resizer.removeClass("is-active");
			this.resizingColumn = null;
			if (persist && current !== startWidth) this.saveColumnSize(column, current);
			else if (!persist) col.style.width = `${startWidth}px`;
		};

		resizer.addEventListener(
			"pointermove",
			(moveEvent) => {
				const width = clampColumnWidth(startWidth + moveEvent.clientX - startX);
				if (width === current) return;
				current = width;
				col.style.width = `${width}px`;
			},
			{ signal },
		);
		resizer.addEventListener("pointerup", () => finish(true), { signal });
		resizer.addEventListener("pointercancel", () => finish(false), { signal });
		resizer.addEventListener("lostpointercapture", () => finish(false), { signal });
	}

	private resetColumnSize(
		column: BasesPropertyId,
		col: HTMLTableColElement | undefined,
		indexId: BasesPropertyId,
	): void {
		this.saveColumnSize(column, null);
		if (col) col.style.width = `${clampColumnWidth(this.estimateColumnWidth(column, indexId))}px`;
	}

	private moveColumn(
		columns: BasesPropertyId[],
		source: BasesPropertyId,
		target: BasesPropertyId,
		after: boolean,
	): void {
		if (source === target) return;
		const next = columns.filter((property) => property !== source);
		const targetIndex = next.indexOf(target);
		if (targetIndex < 0) return;
		next.splice(targetIndex + (after ? 1 : 0), 0, source);
		if (!this.writeColumnOrder(next)) return;
		this.onDataUpdated();
	}

	private clearColumnDropTargets(): void {
		this.root
			.querySelectorAll<HTMLElement>(".fiv-col-drop-before, .fiv-col-drop-after")
			.forEach((element) => {
				element.removeClass("fiv-col-drop-before");
				element.removeClass("fiv-col-drop-after");
			});
	}

	private rawIndex(file: TFile, property: string): unknown {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return frontmatter ? (frontmatter as Record<string, unknown>)[property] : undefined;
	}

	private buildRows(notes: BasesEntry[], property: string): Row[] {
		const hasNativeSort = this.config.getSort().length > 0;
		const unindexedRank = new Map<string, number>();
		if (hasNativeSort) {
			notes.forEach((entry, index) => unindexedRank.set(entry.file.path, index));
		} else {
			[...notes]
				.sort((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
				.forEach((entry, index) => unindexedRank.set(entry.file.path, index));
		}

		return notes.map((entry) => {
			const index = this.rawIndex(entry.file, property);
			try {
				indexKey(index);
			} catch (error) {
				throw new Error(`${entry.file.path}: ${errorMessage(error)}`);
			}
			return { id: entry.file.path, index, unindexedRank: unindexedRank.get(entry.file.path) };
		});
	}

	private isBelow(tr: HTMLTableRowElement, event: DragEvent): boolean {
		const rect = tr.getBoundingClientRect();
		return event.clientY > rect.top + rect.height / 2;
	}

	private clearDropTargets(): void {
		this.root
			.querySelectorAll<HTMLElement>(".fiv-drop-above, .fiv-drop-below")
			.forEach((element) => {
				element.removeClass("fiv-drop-above");
				element.removeClass("fiv-drop-below");
			});
	}

	private confirmAction(options: ConfirmActionOptions): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmWritesModal(this.app, options, resolve).open();
		});
	}

	async move(
		groupIndex: number,
		source: string,
		beforeDisplay: string | null,
		property: string,
		direction: OrderDirection,
	): Promise<void> {
		return this.applyPlan(groupIndex, property, direction, (rows) =>
			planDisplayMove(rows, source, beforeDisplay, direction),
		);
	}

	private async moveDrop(
		groupIndex: number,
		source: string,
		beforeDisplay: string | null,
		property: string,
		direction: OrderDirection,
	): Promise<void> {
		return this.applyPlan(groupIndex, property, direction, (rows) =>
			planDrop(rows, source, beforeDisplay, direction),
		);
	}

	private async moveToEdge(
		groupIndex: number,
		source: string,
		edge: Edge,
		property: string,
		direction: OrderDirection,
	): Promise<void> {
		return this.applyPlan(groupIndex, property, direction, (rows) =>
			planEdgeMove(rows, source, edge, direction),
		);
	}

	private async rebalance(property: string, direction: OrderDirection): Promise<void> {
		return this.applyPlan(
			0,
			property,
			direction,
			(rows) => planBalance(rows),
			{
				action: "rebalance",
				confirm: (count) => ({
					title: "Confirm rebalance",
					message: `This will rebalance ${count} indexed note${count === 1 ? "" : "s"}. Obsidian will re-serialize their frontmatter. Continue?`,
					confirm: `Rebalance ${count} note${count === 1 ? "" : "s"}`,
				}),
			},
		);
	}

	private async applyPlan(
		groupIndex: number,
		property: string,
		direction: OrderDirection,
		plan: (rows: Row[]) => IndexWrite[],
		options?: {
			action?: "move" | "rebalance";
			confirm?: (count: number) => ConfirmActionOptions | null;
		},
	): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.root.setAttribute("aria-busy", "true");

		const action = options?.action ?? "move";
		const written: { file: TFile; write: IndexWrite; hadProperty: boolean }[] = [];
		try {
			const group = this.effectiveGroups[groupIndex];
			if (!group) throw new Error("The group changed. Try again.");

			const notes = group.entries.filter((entry) => entry.file.extension === "md");
			const rows = this.buildRows(notes, property);
			const writes = plan(rows);
			if (writes.length === 0) {
				if (action === "rebalance") new Notice("No indexed notes need balancing.");
				return;
			}
			const confirm =
				options?.confirm?.(writes.length) ??
				(writes.length > 10
					? {
							title: "Confirm index updates",
							message: `This move updates ${writes.length} notes. Obsidian will re-serialize their frontmatter. Continue?`,
							confirm: `Update ${writes.length} notes`,
						}
					: null);
			if (confirm && !(await this.confirmAction(confirm))) return;
			if (indexProperty(this.config.get(INDEX_PROPERTY_OPTION)) !== property) {
				throw new Error("The index property changed. Try again.");
			}
			if (sortDirection(this.config.get(SORT_DIRECTION_OPTION)) !== direction) {
				throw new Error("The sort direction changed. Try again.");
			}

			const files = writes.map((write) => {
				const file = this.app.vault.getFileByPath(write.id);
				if (!file || file.extension !== "md") {
					throw new Error("Only Markdown notes can store a fractional index.");
				}
				return { file, write };
			});

			for (const { file, write } of files) {
				let hadProperty = false;
				await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
					if (!sameIndexValue(frontmatter[property], write.previous)) {
						throw new Error(
							action === "rebalance"
								? "The index changed during this rebalance. Try again."
								: "The index changed during this move. Try again.",
						);
					}
					hadProperty = Object.prototype.hasOwnProperty.call(frontmatter, property);
					frontmatter[property] = write.index;
				});
				written.push({ file, write, hadProperty });
			}
		} catch (error) {
			const failed: string[] = [];
			for (const { file, write, hadProperty } of [...written].reverse()) {
				try {
					await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
						if (!sameIndexValue(frontmatter[property], write.index)) {
							throw new Error("The index changed since this action.");
						}
						if (hadProperty) frontmatter[property] = write.previous;
						else delete frontmatter[property];
					});
				} catch {
					failed.push(file.path);
				}
			}
			const recovery = failed.length
				? ` Could not restore: ${failed.join(", ")}. Check these notes before retrying.`
				: written.length
					? ` Restored ${written.length} note${written.length === 1 ? "" : "s"}.`
					: "";
			const label = action === "rebalance" ? "rebalance" : "move";
			new Notice(`Could not complete the ${label}:${recovery} ${errorMessage(error)}`.trim());
		} finally {
			this.busy = false;
			this.root.removeAttribute("aria-busy");
			this.queueRender();
		}
	}
}

interface ConfirmActionOptions {
	title: string;
	message: string;
	confirm: string;
}

class ConfirmWritesModal extends Modal {
	private accepted = false;

	constructor(
		app: App,
		private readonly options: ConfirmActionOptions,
		private readonly done: (accepted: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", { text: this.options.message });

		const cancel = this.contentEl.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const confirm = this.contentEl.createEl("button", {
			text: this.options.confirm,
			cls: "mod-cta",
		});
		confirm.addEventListener("click", () => {
			this.accepted = true;
			this.close();
		});

		cancel.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.done(this.accepted);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
