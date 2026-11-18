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
	indexKey,
	indexProperty,
	planMove,
	sameIndexValue,
	sortRows,
	type IndexWrite,
	type Row,
} from "./order";

const NOTE_COLUMN = "file.name" as BasesPropertyId;

interface DisplayRow {
	entry: BasesEntry;
	row: Row;
}

export class FractionalIndexView extends BasesView {
	type = "fractional-index-view";

	private readonly root: HTMLElement;
	private busy = false;
	private dragged: { id: string; group: number } | null = null;

	constructor(controller: QueryController, container: HTMLElement) {
		super(controller);
		this.root = container.createDiv({ cls: "fiv-view" });
	}

	onunload(): void {
		this.root.empty();
	}

	onDataUpdated(): void {
		if (this.busy || !this.data) return;

		const active = this.root.doc.activeElement;
		const focused =
			active && this.root.contains(active) ? active.getAttribute("aria-label") : null;

		this.root.empty();

		let property: string;
		try {
			property = indexProperty(this.config.get(INDEX_PROPERTY_OPTION));
		} catch (error) {
			this.root.createEl("p", { cls: "fiv-error", text: errorMessage(error) });
			return;
		}

		const toolbar = this.root.createDiv({ cls: "fiv-toolbar" });
		toolbar.createSpan({
			cls: "fiv-toolbar-title",
			text: `Index property: ${property}`,
		});
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

		const groups = this.data.groupedData;
		groups.forEach((group, groupIndex) => {
			this.renderGroup(groupIndex, group, property);
		});

		if (focused) {
			Array.from(this.root.querySelectorAll<HTMLButtonElement>("button"))
				.find((button) => button.getAttribute("aria-label") === focused)
				?.focus();
		}
	}

	private renderGroup(groupIndex: number, group: BasesEntryGroup, property: string): void {
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
			movable = sortRows(rows);
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
			text: "Move",
			attr: { scope: "col" },
		});
		head.createEl("th", { text: "Note", attr: { scope: "col" } });
		for (const column of columns) {
			head.createEl("th", {
				text: this.config.getDisplayName(column),
				attr: { scope: "col" },
			});
		}

		const body = table.createEl("tbody");
		display.forEach(({ entry, row }, position) => {
			const movableIndex = movable.findIndex((candidate) => candidate.id === row.id);
			const tr = body.createEl("tr", { attr: { "data-path": row.id } });
			this.renderControls(tr, groupIndex, row, entry, movable, movableIndex, property);
			this.renderNoteCell(tr, entry);

			for (const column of columns) {
				if (column === indexId) this.renderIndexCell(tr, row, position);
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
					const before = below ? movable[movableIndex + 1]?.id ?? null : row.id;
					if (drag.id === before) return;
					void this.move(groupIndex, drag.id, before, property);
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
	): void {
		const cell = tr.createEl("td", { cls: "fiv-controls" });
		if (entry.file.extension !== "md" || movableIndex < 0) {
			cell.createSpan({ cls: "fiv-attachment", text: "—" });
			return;
		}

		const name = entry.file.basename;

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

		const top = cell.createEl("button", {
			cls: "fiv-move clickable-icon",
			attr: {
				type: "button",
				"aria-label": `Move ${name} to top`,
				title: "Move to top",
			},
		});
		setIcon(top, "chevrons-up");
		top.disabled = movableIndex <= 0 || this.busy;
		top.addEventListener("click", () => {
			const first = movable[0];
			if (first) void this.move(groupIndex, row.id, first.id, property);
		});

		const bottom = cell.createEl("button", {
			cls: "fiv-move clickable-icon",
			attr: {
				type: "button",
				"aria-label": `Move ${name} to bottom`,
				title: "Move to bottom",
			},
		});
		setIcon(bottom, "chevrons-down");
		bottom.disabled = movableIndex === movable.length - 1 || this.busy;
		bottom.addEventListener("click", () => {
			void this.move(groupIndex, row.id, null, property);
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

	private renderIndexCell(tr: HTMLTableRowElement, row: Row, position: number): void {
		const cell = tr.createEl("td", { cls: "fiv-index" });
		const key = typeof row.index === "string" && row.index !== "" ? row.index : null;
		if (key === null) {
			cell.createSpan({ cls: "fiv-index-empty", text: "—" });
		} else {
			cell.createSpan({ cls: "fiv-index-key", text: key });
		}
		cell.createSpan({
			cls: "fiv-index-order",
			text: `#${position + 1}`,
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
		return order.includes(indexId) ? order : [indexId, ...order];
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
		before: string | null,
		property: string,
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
			const writes = planMove(rows, source, before);
			if (writes.length === 0) return;
			if (writes.length > 10 && !(await this.confirmWrites(writes.length))) return;
			if (indexProperty(this.config.get(INDEX_PROPERTY_OPTION)) !== property) {
				throw new Error("The index property changed. Try the move again.");
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
