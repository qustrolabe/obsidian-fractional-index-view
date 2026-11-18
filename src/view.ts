import {
	BasesView,
	Modal,
	Notice,
	setIcon,
	type App,
	type BasesEntry,
	type BasesEntryGroup,
	type BasesPropertyId,
	type QueryController,
	type TFile,
} from "obsidian";
import {
	INDEX_PROPERTY_OPTION,
	SORT_DIRECTION_OPTION,
	displayRows,
	indexKey,
	indexProperty,
	planDisplayMove,
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

interface DisplayRow {
	entry: BasesEntry;
	row: Row;
}

export class FractionalIndexView extends BasesView {
	type = "fractional-index-view";

	private readonly root: HTMLElement;
	private busy = false;
	private seeding = false;
	private readonly seedAttempted = new Set<string>();
	private dragged: { id: string; group: number } | null = null;
	private draggedColumn: BasesPropertyId | null = null;

	constructor(controller: QueryController, container: HTMLElement) {
		super(controller);
		this.root = container.createDiv({ cls: "fiv-view" });
	}

	onunload(): void {
		this.root.empty();
	}

	onDataUpdated(): void {
		if (this.busy || this.seeding || !this.data) return;

		const active = this.root.doc.activeElement;
		const focused = active && this.root.contains(active) ? this.focusKey(active) : null;

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

		const toolbar = this.root.createDiv({ cls: "fiv-toolbar" });
		toolbar.createSpan({
			cls: "fiv-toolbar-title",
			text: `Index property: ${property}`,
		});
		this.renderDirection(toolbar, direction);
		toolbar.createSpan({
			cls: "fiv-toolbar-count",
			text: `${this.data.data.length} item${this.data.data.length === 1 ? "" : "s"}`,
		});

		if (this.data.data.length === 0) {
			this.root.createEl("p", {
				cls: "fiv-empty",
				text: "No notes match this base. Change its filters to show notes.",
			});
			return;
		}

		const ordinalWidth = Math.max(1, String(this.data.data.length).length);
		const groups = this.data.groupedData;
		groups.forEach((group, groupIndex) => {
			this.renderGroup(groupIndex, group, property, direction, ordinalWidth);
		});

		if (focused) {
			Array.from(this.root.querySelectorAll<HTMLButtonElement>("button"))
				.find((button) => this.focusKey(button) === focused)
				?.focus();
		}
	}

	private focusKey(element: Element): string | null {
		return element.getAttribute("data-fiv-focus") ?? element.getAttribute("aria-label");
	}

	private renderGroup(
		groupIndex: number,
		group: BasesEntryGroup,
		property: string,
		direction: OrderDirection,
		ordinalWidth: number,
	): void {
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
			rows = notes.map((entry) => {
				const index = this.rawIndex(entry.file, property);
				try {
					indexKey(index);
				} catch (error) {
					throw new Error(`${entry.file.path}: ${errorMessage(error)}`);
				}
				return { id: entry.file.path, index };
			});
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

		const indexId = `note.${property}` as BasesPropertyId;
		const columns = this.columns(indexId);
		const table = section.createEl("table", { cls: "fiv-table" });
		const head = table.createEl("thead").createEl("tr");
		head.createEl("th", {
			cls: "fiv-controls-head",
			attr: { scope: "col", "aria-label": "Row controls" },
		});
		head.createEl("th", { cls: "fiv-note-head", text: "Note", attr: { scope: "col" } });
		for (const column of columns) {
			this.renderColumnHeader(head, column, indexId);
		}

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
				property,
				direction,
				indexed,
			);
			this.renderNoteCell(tr, entry);

			for (const column of columns) {
				if (column === indexId) this.renderIndexCell(tr, row, position, ordinalWidth);
				else this.renderValueCell(tr, entry, column);
			}

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
					void this.move(groupIndex, drag.id, beforeDisplay, property, direction);
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
		const isLast = movableIndex === movable.length - 1;

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
				if (before) void this.move(groupIndex, row.id, before.id, property, direction);
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
			down.disabled = isLast || this.busy;
			down.addEventListener("click", () => {
				const beforeDisplay = movable[movableIndex + 2]?.id ?? null;
				void this.move(groupIndex, row.id, beforeDisplay, property, direction);
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
		} else {
			inner.createSpan({ cls: "fiv-index-key", text: key });
		}
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

	private columns(indexId: BasesPropertyId): BasesPropertyId[] {
		const order = this.config.getOrder().filter((property) => property !== NOTE_COLUMN);
		if (!this.indexColumnVisible(indexId)) return order;
		return order.includes(indexId) ? order : [indexId, ...order];
	}

	private indexColumnVisible(indexId: BasesPropertyId): boolean {
		if (this.config.getOrder().includes(indexId)) return true;
		return this.config.get(INDEX_COLUMN_SEEDED_OPTION) !== indexId;
	}

	/**
	 * Put the index property into the native Properties list once, so that the
	 * menu shows it as selected and the user can move or hide the column.
	 * If Bases rejects the write, the view keeps rendering the column itself.
	 */
	private seedIndexColumn(property: string): void {
		const indexId = `note.${property}` as BasesPropertyId;
		const order = this.config.getOrder();
		if (order.includes(indexId)) {
			this.rememberSeededIndex(indexId);
			return;
		}
		if (this.config.get(INDEX_COLUMN_SEEDED_OPTION) === indexId) return;
		// Try once per view instance. If the Bases version rejects the write we
		// keep rendering the column locally instead of retrying on every update.
		if (this.seedAttempted.has(indexId)) return;
		this.seedAttempted.add(indexId);

		try {
			const noteIndex = order.indexOf(NOTE_COLUMN);
			const next = [...order];
			next.splice(noteIndex < 0 ? 0 : noteIndex + 1, 0, indexId);
			this.config.set("order", next);
			if (this.config.getOrder().includes(indexId)) this.rememberSeededIndex(indexId);
		} catch {
			// Some Bases versions may not let plugins write the column order.
		}
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

	private renderColumnHeader(
		head: HTMLTableRowElement,
		column: BasesPropertyId,
		indexId: BasesPropertyId,
	): void {
		const th = head.createEl("th", {
			cls: column === indexId ? "fiv-col fiv-index-head" : "fiv-col",
			text: this.config.getDisplayName(column),
			attr: { scope: "col", "data-property": column },
		});
		if (!this.config.getOrder().includes(column)) return;

		th.draggable = true;
		th.addClass("fiv-col-draggable");
		th.title = "Drag to reorder columns";
		th.addEventListener("dragstart", (event) => {
			if (this.busy) {
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
			this.moveColumn(column, source, event.clientX > rect.left + rect.width / 2);
		});
	}

	private moveColumn(target: BasesPropertyId, source: BasesPropertyId, after: boolean): void {
		const full = this.config.getOrder();
		const columns = full.filter((property) => property !== NOTE_COLUMN);
		if (!columns.includes(source) || !columns.includes(target)) return;

		columns.splice(columns.indexOf(source), 1);
		const targetIndex = columns.indexOf(target);
		columns.splice(targetIndex + (after ? 1 : 0), 0, source);

		const noteIndex = full.indexOf(NOTE_COLUMN);
		const next = [...columns];
		if (noteIndex >= 0) next.splice(Math.min(noteIndex, next.length), 0, NOTE_COLUMN);
		try {
			this.config.set("order", next);
		} catch (error) {
			new Notice(`Could not save the column order: ${errorMessage(error)}`);
			return;
		}
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

	private confirmWrites(count: number): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmWritesModal(this.app, count, resolve).open();
		});
	}

	async move(
		groupIndex: number,
		source: string,
		beforeDisplay: string | null,
		property: string,
		direction: OrderDirection,
	): Promise<void> {
		return this.applyMove(groupIndex, property, direction, (rows) =>
			planDisplayMove(rows, source, beforeDisplay, direction),
		);
	}

	private async moveToEdge(
		groupIndex: number,
		source: string,
		edge: Edge,
		property: string,
		direction: OrderDirection,
	): Promise<void> {
		return this.applyMove(groupIndex, property, direction, (rows) =>
			planEdgeMove(rows, source, edge, direction),
		);
	}

	private async applyMove(
		groupIndex: number,
		property: string,
		direction: OrderDirection,
		plan: (rows: Row[]) => IndexWrite[],
	): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.root.setAttribute("aria-busy", "true");

		const written: { file: TFile; write: IndexWrite; hadProperty: boolean }[] = [];
		try {
			const group = this.data.groupedData[groupIndex];
			if (!group) throw new Error("The group changed. Try the move again.");

			const rows = group.entries
				.filter((entry) => entry.file.extension === "md")
				.map((entry) => ({
					id: entry.file.path,
					index: this.rawIndex(entry.file, property),
				}));
			const writes = plan(rows);
			if (writes.length === 0) return;
			if (writes.length > 10 && !(await this.confirmWrites(writes.length))) return;
			if (indexProperty(this.config.get(INDEX_PROPERTY_OPTION)) !== property) {
				throw new Error("The index property changed. Try the move again.");
			}
			if (sortDirection(this.config.get(SORT_DIRECTION_OPTION)) !== direction) {
				throw new Error("The sort direction changed. Try the move again.");
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
						throw new Error("The index changed during this move. Try again.");
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
							throw new Error("The index changed since this move.");
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
			new Notice(`Could not complete the move:${recovery} ${errorMessage(error)}`.trim());
		} finally {
			this.busy = false;
			this.root.removeAttribute("aria-busy");
			this.onDataUpdated();
		}
	}
}

class ConfirmWritesModal extends Modal {
	private accepted = false;

	constructor(
		app: App,
		private readonly count: number,
		private readonly done: (accepted: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Confirm index updates");
		this.contentEl.createEl("p", {
			text: `This move updates ${this.count} notes. Obsidian will re-serialize their frontmatter. Continue?`,
		});

		const cancel = this.contentEl.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const confirm = this.contentEl.createEl("button", {
			text: `Update ${this.count} notes`,
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
