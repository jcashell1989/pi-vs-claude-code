/**
 * TaskStore — Persistent CRUD for `.pi/tasks/tasks.json`
 *
 * Every mutating operation writes to disk immediately via fs.writeFileSync.
 * Single active task invariant: toggling a task to inprogress demotes any
 * other inprogress task to idle.
 */

import * as fs from "fs";
import * as path from "path";

// ── Types ──────────────────────────────────────────────────────────────

export type TaskStatus = "idle" | "inprogress" | "done";

export interface Task {
	id: number;
	text: string;
	status: TaskStatus;
	branch: string | null;
	pr: string | null;
	created: string; // ISO 8601
	completed: string | null;
	cost: number; // accumulated cost in dollars
}

export interface TaskStoreData {
	nextId: number;
	listTitle: string;
	tasks: Task[];
}

export interface TaskStore {
	// Read
	getAll(): Task[];
	getById(id: number): Task | undefined;
	getActive(): Task | undefined; // the single in-progress task
	getTitle(): string;

	// Write
	add(text: string): Task;
	addBatch(texts: string[]): Task[];
	toggle(id: number): Task; // idle->inprogress->done cycle, demotes other active tasks
	remove(id: number): void;
	update(id: number, text: string): void;
	clear(): void;
	newList(title: string): void;

	// Git integration
	setBranch(id: number, branch: string): void;
	setPr(id: number, pr: string): void;
	addCost(id: number, amount: number): void;

	// State
	getData(): TaskStoreData;
	hasActiveTasks(): boolean; // any non-done tasks exist
	summary(): string; // human-readable summary for compaction injection
}

// ── Status cycle ───────────────────────────────────────────────────────

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
	idle: "inprogress",
	inprogress: "done",
	done: "idle",
};

const STATUS_ICON: Record<TaskStatus, string> = {
	idle: "○",
	inprogress: "●",
	done: "✓",
};

// ── Helpers ────────────────────────────────────────────────────────────

function freshData(): TaskStoreData {
	return { nextId: 1, listTitle: "pi-shell session", tasks: [] };
}

function isValidData(obj: unknown): obj is TaskStoreData {
	if (typeof obj !== "object" || obj === null) return false;
	const d = obj as Record<string, unknown>;
	return (
		typeof d.nextId === "number" &&
		typeof d.listTitle === "string" &&
		Array.isArray(d.tasks)
	);
}

// ── Factory ────────────────────────────────────────────────────────────

export function createTaskStore(cwd?: string): TaskStore {
	const root = cwd || process.cwd();
	const dir = path.join(root, ".pi", "tasks");
	const filePath = path.join(dir, "tasks.json");

	// Load or create fresh state
	let data: TaskStoreData = load();

	function load(): TaskStoreData {
		try {
			if (fs.existsSync(filePath)) {
				const raw = fs.readFileSync(filePath, "utf-8");
				const parsed = JSON.parse(raw);
				if (isValidData(parsed)) return parsed;
			}
		} catch {
			// Corrupt or missing — fall through to fresh state
		}
		return freshData();
	}

	function save(): void {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	}

	function findTask(id: number): Task {
		const task = data.tasks.find((t) => t.id === id);
		if (!task) throw new Error(`Task #${id} not found`);
		return task;
	}

	const store: TaskStore = {
		// ── Read ───────────────────────────────────────────────────────

		getAll(): Task[] {
			return [...data.tasks];
		},

		getById(id: number): Task | undefined {
			return data.tasks.find((t) => t.id === id);
		},

		getActive(): Task | undefined {
			return data.tasks.find((t) => t.status === "inprogress");
		},

		getTitle(): string {
			return data.listTitle;
		},

		// ── Write ──────────────────────────────────────────────────────

		add(text: string): Task {
			const task: Task = {
				id: data.nextId++,
				text,
				status: "idle",
				branch: null,
				pr: null,
				created: new Date().toISOString(),
				completed: null,
				cost: 0,
			};
			data.tasks.push(task);
			save();
			return task;
		},

		addBatch(texts: string[]): Task[] {
			const added: Task[] = [];
			for (const text of texts) {
				const task: Task = {
					id: data.nextId++,
					text,
					status: "idle",
					branch: null,
					pr: null,
					created: new Date().toISOString(),
					completed: null,
					cost: 0,
				};
				data.tasks.push(task);
				added.push(task);
			}
			save();
			return added;
		},

		toggle(id: number): Task {
			const task = findTask(id);
			const prev = task.status;
			task.status = NEXT_STATUS[prev];

			// When toggling TO inprogress, demote any other inprogress task
			if (task.status === "inprogress") {
				for (const t of data.tasks) {
					if (t.id !== task.id && t.status === "inprogress") {
						t.status = "idle";
					}
				}
			}

			// When toggling TO done, set completed timestamp
			if (task.status === "done") {
				task.completed = new Date().toISOString();
			}

			// When toggling FROM done back to idle, clear completed
			if (prev === "done" && task.status === "idle") {
				task.completed = null;
			}

			save();
			return task;
		},

		remove(id: number): void {
			const idx = data.tasks.findIndex((t) => t.id === id);
			if (idx === -1) throw new Error(`Task #${id} not found`);
			data.tasks.splice(idx, 1);
			save();
		},

		update(id: number, text: string): void {
			const task = findTask(id);
			task.text = text;
			save();
		},

		clear(): void {
			data.tasks = [];
			data.nextId = 1;
			save();
		},

		newList(title: string): void {
			data = { nextId: 1, listTitle: title, tasks: [] };
			save();
		},

		// ── Git integration ────────────────────────────────────────────

		setBranch(id: number, branch: string): void {
			const task = findTask(id);
			task.branch = branch;
			save();
		},

		setPr(id: number, pr: string): void {
			const task = findTask(id);
			task.pr = pr;
			save();
		},

		addCost(id: number, amount: number): void {
			const task = findTask(id);
			task.cost += amount;
			save();
		},

		// ── State ──────────────────────────────────────────────────────

		getData(): TaskStoreData {
			return { ...data, tasks: [...data.tasks] };
		},

		hasActiveTasks(): boolean {
			return data.tasks.some((t) => t.status !== "done");
		},

		summary(): string {
			const total = data.tasks.length;
			if (total === 0) return `${data.listTitle}: no tasks`;

			const done = data.tasks.filter((t) => t.status === "done").length;
			const active = data.tasks.filter((t) => t.status === "inprogress").length;
			const idle = data.tasks.filter((t) => t.status === "idle").length;
			const totalCost = data.tasks.reduce((sum, t) => sum + t.cost, 0);

			const lines: string[] = [];
			lines.push(
				`${data.listTitle} [${done}/${total} done, ${active} active, ${idle} idle] $${totalCost.toFixed(2)}`
			);

			for (const t of data.tasks) {
				const icon = STATUS_ICON[t.status];
				const branchInfo = t.branch ? ` (${t.branch})` : "";
				const prInfo = t.pr ? ` PR: ${t.pr}` : "";
				lines.push(`  ${icon} #${t.id} [${t.status}] ${t.text}${branchInfo}${prInfo}`);
			}

			return lines.join("\n");
		},
	};

	return store;
}
