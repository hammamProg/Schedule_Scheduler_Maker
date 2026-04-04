import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Calendar,
  Clock,
  BookOpen,
  Settings,
  X,
  Download,
  Upload,
  Edit2,
  Image as ImageIcon,
  Check,
  Users,
  History,
  FolderOpen,
  Save,
  FilePlus2,
} from 'lucide-react';
import { toPng } from 'html-to-image';

type Day =
  | 'الأحد'
  | 'الإثنين'
  | 'الثلاثاء'
  | 'الأربعاء'
  | 'الخميس'
  | 'الجمعة'
  | 'السبت';
type Period = 'الأولى' | 'الثانية' | 'الثالثة' | 'الرابعة' | 'الخامسة' | 'السادسة' | 'السابعة';
type Grade = 'الأول' | 'الثاني' | 'الثالث' | 'الرابع' | 'الخامس' | 'السادس' | 'السابع' | 'الثامن' | 'التاسع' | 'العاشر' | '١١' | '١٢';

type Teacher = {
  id: string;
  name: string;
};

type Subject = {
  id: string;
  name: string;
  teacherId: string;
};

/** Legacy: subject had `teacher` as free text; import may still use it. */
type LegacySubjectRow = {
  id: string;
  name: string;
  teacher?: string;
  teacherId?: string;
};

function newEntityId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

/** Trim and collapse spaces so «أحمد  علي» matches «أحمد علي». */
function normalizeTeacherNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Same normalization for subject names when comparing duplicates. */
function normalizeSubjectNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function subjectTeacherPairKey(normalizedSubjectName: string, teacherId: string): string {
  return `${normalizedSubjectName}\u0000${teacherId || ''}`;
}

/** Keep first row per (normalized name, teacherId); map dropped ids → canonical id for schedule fixes. */
function dedupeSubjectsByPair(subjects: Subject[]): { subjects: Subject[]; idRemap: Map<string, string> } {
  const keyToCanonicalId = new Map<string, string>();
  const idRemap = new Map<string, string>();
  const kept: Subject[] = [];
  for (const s of subjects) {
    const key = subjectTeacherPairKey(normalizeSubjectNameKey(s.name), s.teacherId);
    const canon = keyToCanonicalId.get(key);
    if (canon === undefined) {
      keyToCanonicalId.set(key, s.id);
      kept.push(s);
    } else {
      idRemap.set(s.id, canon);
    }
  }
  return { subjects: kept, idRemap };
}

function remapScheduleSubjectIds(
  sched: Record<string, Record<string, Record<string, string>>>,
  idRemap: Map<string, string>
): Record<string, Record<string, Record<string, string>>> {
  if (idRemap.size === 0) return sched;
  const next: Record<string, Record<string, Record<string, string>>> = {};
  for (const day of Object.keys(sched)) {
    next[day] = {};
    for (const period of Object.keys(sched[day])) {
      next[day][period] = {};
      for (const grade of Object.keys(sched[day][period])) {
        const sid = sched[day][period][grade];
        next[day][period][grade] = idRemap.get(sid) ?? sid;
      }
    }
  }
  return next;
}

function migrateLegacySubjectsToTeachers(raw: unknown[]): { teachers: Teacher[]; subjects: Subject[] } {
  const teachersByName = new Map<string, Teacher>();

  function teacherIdForName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '';
    let t = teachersByName.get(trimmed);
    if (!t) {
      t = { id: newEntityId(), name: trimmed };
      teachersByName.set(trimmed, t);
    }
    return t.id;
  }

  const subjects: Subject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as LegacySubjectRow;
    if (!o.id || !o.name) continue;
    let teacherId = typeof o.teacherId === 'string' ? o.teacherId : '';
    if (typeof o.teacher === 'string' && o.teacher.trim() && !teacherId) {
      teacherId = teacherIdForName(o.teacher);
    }
    subjects.push({
      id: String(o.id),
      name: String(o.name),
      teacherId,
    });
  }
  return { teachers: Array.from(teachersByName.values()), subjects };
}

function normalizeSubjectImport(
  rawSubs: unknown[],
  initialTeachers: Teacher[]
): { teachers: Teacher[]; subjects: Subject[] } {
  const byId = new Map<string, Teacher>(initialTeachers.map((t) => [t.id, t]));
  const byName = new Map<string, Teacher>();
  for (const t of byId.values()) {
    byName.set(t.name.trim(), t);
  }

  function ensureTeacher(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '';
    let t = byName.get(trimmed);
    if (!t) {
      t = { id: newEntityId(), name: trimmed };
      byId.set(t.id, t);
      byName.set(trimmed, t);
    }
    return t.id;
  }

  const subjects: Subject[] = [];
  for (const item of rawSubs) {
    if (!item || typeof item !== 'object') continue;
    const o = item as LegacySubjectRow;
    if (!o.id || !o.name) continue;
    let teacherId = typeof o.teacherId === 'string' ? o.teacherId : '';
    if (teacherId && !byId.has(teacherId)) {
      teacherId = '';
    }
    if (!teacherId && typeof o.teacher === 'string' && o.teacher.trim()) {
      teacherId = ensureTeacher(o.teacher);
    }
    subjects.push({
      id: String(o.id),
      name: String(o.name),
      teacherId,
    });
  }
  return { teachers: Array.from(byId.values()), subjects };
}

type ConfirmState = {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
};

type EditingCell = {
  day: Day;
  period: Period;
  grade: Grade;
  /** When set, subject search opens with this text (first key typed on the grid cell). */
  filterPrefill?: string;
};

/** Per-period slot times as HH:MM (24h), suitable for `input type="time"`. */
type PeriodTimeSlot = { start: string; end: string };

type TableSnapshot = {
  /** ISO date YYYY-MM-DD; weekday for the schedule grid is derived from this. */
  scheduleDate: string;
  /** Shown on the schedule header and included in exported PNG. */
  schoolName: string;
  teachers: Teacher[];
  subjects: Subject[];
  schedule: Record<string, Record<string, Record<string, string>>>;
  times: Record<string, PeriodTimeSlot>;
};

/** In-memory undo/redo (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z); not persisted. */
type UndoableAppSnapshot = {
  schedule: TableSnapshot['schedule'];
  teachers: Teacher[];
  subjects: Subject[];
  times: Record<string, PeriodTimeSlot>;
  schoolName: string;
  scheduleDate: string;
};

/** Older saves used selectedDay + dates map. */
type LegacySnapshotFields = {
  scheduleDate?: string;
  selectedDay?: Day;
  dates?: Record<string, string>;
};

/** Snapshot as stored in localStorage (new or legacy shape). */
type LoadedTableSnapshot = LegacySnapshotFields & {
  schoolName?: string;
  teachers: Teacher[];
  subjects: Subject[];
  schedule: TableSnapshot['schedule'];
  times: TableSnapshot['times'];
};

type SavedTableEntry = {
  id: string;
  name: string;
  updatedAt: string;
  snapshot: LoadedTableSnapshot;
};

function buildSnapshot(
  scheduleDate: string,
  schoolName: string,
  teachers: Teacher[],
  subjects: Subject[],
  schedule: TableSnapshot['schedule'],
  times: TableSnapshot['times']
): TableSnapshot {
  return {
    scheduleDate,
    schoolName,
    teachers: JSON.parse(JSON.stringify(teachers)),
    subjects: JSON.parse(JSON.stringify(subjects)),
    schedule: JSON.parse(JSON.stringify(schedule)),
    times: JSON.parse(JSON.stringify(times)),
  };
}

function todayISODate(): string {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, '0');
  const d = String(n.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseISODateLocal(iso: string): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const ARABIC_WEEKDAYS: Day[] = [
  'الأحد',
  'الإثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت',
];

function isoDateToArabicWeekday(iso: string): Day {
  const dt = parseISODateLocal(iso);
  if (!dt) return 'الأحد';
  return ARABIC_WEEKDAYS[dt.getDay()] ?? 'الأحد';
}

function formatISODateArabicLong(iso: string): string {
  const dt = parseISODateLocal(iso);
  if (!dt) return iso;
  try {
    return dt.toLocaleDateString('ar', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function resolveSnapshotScheduleDate(snap: LoadedTableSnapshot): string {
  if (typeof snap.scheduleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(snap.scheduleDate)) {
    return snap.scheduleDate;
  }
  const dates = snap.dates ?? {};
  const day = snap.selectedDay;
  if (day && typeof dates[day] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dates[day])) {
    return dates[day];
  }
  const first = Object.values(dates).find((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
  if (first) return first;
  return todayISODate();
}

const ALL_GRADES: Grade[] = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر', '١١', '١٢'];
const PERIODS: Period[] = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة'];

/** First period starts 08:00; each session 35 min, then 5 min break before the next period starts. */
const STANDARD_SESSION_MINUTES = 35;
const STANDARD_BREAK_MINUTES = 5;

function minutesFromMidnightToHHMM(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function buildStandardPeriodTimes(periods: readonly Period[]): Record<string, PeriodTimeSlot> {
  const dayStartMin = 8 * 60;
  const block = STANDARD_SESSION_MINUTES + STANDARD_BREAK_MINUTES;
  const out: Record<string, PeriodTimeSlot> = {};
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    const startMin = dayStartMin + i * block;
    const endMin = startMin + STANDARD_SESSION_MINUTES;
    out[p] = {
      start: minutesFromMidnightToHHMM(startMin),
      end: minutesFromMidnightToHHMM(endMin),
    };
  }
  return out;
}

const SCHEDULE_PNG_EXPORT_HIDE_CLASS = 'schedule-png-export-hidden';

/** Naqsh-tech contribution — site footer and bottom of PNG export. */
const NAQSH_TECH_ATTRIBUTION_AR =
  'تطوير هذا الحل بمساهمة شركة نقش تك للتقنية (Naqsh-tech) لمساعدة المدارس والمعلمين، بالتعاون مع المعلمة الفاضلة قدر عادل في مدرسة الشهيدة رهام دوابشة.';

function scheduleCellStorageKey(period: Period, grade: Grade): string {
  return `${period}\u0000${grade}`;
}

/** Same calendar day + period: one teacher in two or more grades → all those cells' storage keys. Empty teacherId is ignored. */
function teacherCollisionCellKeys(
  day: Day,
  schedule: Record<string, Record<string, Record<string, string>>>,
  subjects: Subject[]
): Set<string> {
  const subjectById = new Map(subjects.map((s) => [s.id, s]));
  const keys = new Set<string>();
  const dayRow = schedule[day];
  for (const period of PERIODS) {
    const byTeacher = new Map<string, Grade[]>();
    for (const grade of ALL_GRADES) {
      const sid = dayRow?.[period]?.[grade] ?? '';
      if (!sid) continue;
      const sub = subjectById.get(sid);
      const tid = (sub?.teacherId ?? '').trim();
      if (!tid) continue;
      let list = byTeacher.get(tid);
      if (!list) {
        list = [];
        byTeacher.set(tid, list);
      }
      list.push(grade);
    }
    for (const grades of byTeacher.values()) {
      if (grades.length < 2) continue;
      for (const g of grades) {
        keys.add(scheduleCellStorageKey(period, g));
      }
    }
  }
  return keys;
}

const SCHEDULE_CELL_CLIPBOARD_MARK = 'psm.scheduleCell.v1' as const;
const SCHEDULE_RANGE_CLIPBOARD_MARK = 'psm.scheduleRange.v1' as const;

function stringifyScheduleCellClipboard(subjectId: string): string {
  return JSON.stringify({ app: SCHEDULE_CELL_CLIPBOARD_MARK, subjectId });
}

/** Returns subject id to paste, or `''` to clear cell; `null` if not our payload. */
function parseScheduleCellClipboard(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed) as { app?: string; subjectId?: unknown };
    if (o.app !== SCHEDULE_CELL_CLIPBOARD_MARK) return null;
    if (typeof o.subjectId !== 'string') return null;
    return o.subjectId;
  } catch {
    return null;
  }
}

type ScheduleRangePayload = {
  app: typeof SCHEDULE_RANGE_CLIPBOARD_MARK;
  rows: number;
  cols: number;
  /** Row-major subject ids; empty string = empty cell */
  cells: string[][];
};

function stringifyScheduleRangeClipboard(matrix: string[][]): string {
  const rows = matrix.length;
  const cols = rows === 0 ? 0 : Math.max(...matrix.map((r) => r.length));
  return JSON.stringify({
    app: SCHEDULE_RANGE_CLIPBOARD_MARK,
    rows,
    cols,
    cells: matrix,
  } satisfies ScheduleRangePayload);
}

function parseScheduleRangeClipboard(text: string): ScheduleRangePayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const o = JSON.parse(trimmed) as {
      app?: string;
      rows?: unknown;
      cols?: unknown;
      cells?: unknown;
    };
    if (o.app !== SCHEDULE_RANGE_CLIPBOARD_MARK) return null;
    if (typeof o.rows !== 'number' || typeof o.cols !== 'number' || !Array.isArray(o.cells)) return null;
    const cells = o.cells as unknown[];
    const matrix: string[][] = [];
    for (const row of cells) {
      if (!Array.isArray(row)) return null;
      matrix.push(row.map((c) => (typeof c === 'string' ? c : '')));
    }
    if (matrix.length !== o.rows) return null;
    for (const r of matrix) {
      if (r.length !== o.cols) return null;
    }
    return { app: SCHEDULE_RANGE_CLIPBOARD_MARK, rows: o.rows, cols: o.cols, cells: matrix };
  } catch {
    return null;
  }
}

type GridCoord = { period: Period; grade: Grade };

function periodGradeIndices(c: GridCoord): { pi: number; gi: number } {
  return { pi: PERIODS.indexOf(c.period), gi: ALL_GRADES.indexOf(c.grade) };
}

/** Inclusive bounding box in index space; returns null if invalid. */
function selectionBBox(a: GridCoord, b: GridCoord): { minPi: number; maxPi: number; minGi: number; maxGi: number } | null {
  const ia = periodGradeIndices(a);
  const ib = periodGradeIndices(b);
  if (ia.pi < 0 || ia.gi < 0 || ib.pi < 0 || ib.gi < 0) return null;
  return {
    minPi: Math.min(ia.pi, ib.pi),
    maxPi: Math.max(ia.pi, ib.pi),
    minGi: Math.min(ia.gi, ib.gi),
    maxGi: Math.max(ia.gi, ib.gi),
  };
}

function isCellInSelectionRange(
  period: Period,
  grade: Grade,
  range: { anchor: GridCoord; extent: GridCoord } | null
): boolean {
  if (!range) return false;
  const box = selectionBBox(range.anchor, range.extent);
  if (!box) return false;
  const { pi, gi } = periodGradeIndices({ period, grade });
  if (pi < 0 || gi < 0) return false;
  return pi >= box.minPi && pi <= box.maxPi && gi >= box.minGi && gi <= box.maxGi;
}

function buildScheduleRangeMatrix(
  day: Day,
  anchor: GridCoord,
  extent: GridCoord,
  schedule: Record<string, Record<string, Record<string, string>>>
): string[][] | null {
  const box = selectionBBox(anchor, extent);
  if (!box) return null;
  const rows: string[][] = [];
  for (let pi = box.minPi; pi <= box.maxPi; pi++) {
    const row: string[] = [];
    for (let gi = box.minGi; gi <= box.maxGi; gi++) {
      const period = PERIODS[pi];
      const grade = ALL_GRADES[gi];
      row.push(schedule[day]?.[period]?.[grade] ?? '');
    }
    rows.push(row);
  }
  return rows;
}

function applyScheduleRangePaste(
  day: Day,
  originPeriod: Period,
  originGrade: Grade,
  payload: ScheduleRangePayload,
  validSubjectIds: Set<string>,
  prev: Record<string, Record<string, Record<string, string>>>
): Record<string, Record<string, Record<string, string>>> {
  const oi = PERIODS.indexOf(originPeriod);
  const oj = ALL_GRADES.indexOf(originGrade);
  if (oi < 0 || oj < 0) return prev;
  const next = { ...prev };
  const nextDay = { ...(next[day] ?? {}) };
  for (let r = 0; r < payload.rows; r++) {
    const pi = oi + r;
    if (pi >= PERIODS.length) break;
    const period = PERIODS[pi];
    const periodRow = { ...(nextDay[period] ?? {}) };
    for (let c = 0; c < payload.cols; c++) {
      const gi = oj + c;
      if (gi >= ALL_GRADES.length) break;
      const grade = ALL_GRADES[gi];
      const sid = payload.cells[r]?.[c] ?? '';
      if (sid === '') {
        delete periodRow[grade];
      } else if (validSubjectIds.has(sid)) {
        periodRow[grade] = sid;
      }
    }
    nextDay[period] = periodRow;
  }
  next[day] = nextDay;
  return next;
}

/**
 * Cell picker search: one token matches subject name or teacher (either).
 * Two+ tokens: first token must appear in subject name; remaining text must appear in teacher name (AND).
 * Example: «عربي رحمة» → subject includes «عربي» and teacher includes «رحمة».
 */
function subjectsMatchingCellFilter(
  list: Subject[],
  query: string,
  resolveTeacherName: (id: string) => string
): Subject[] {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) return list;

  const parts = normalized.split(' ');
  if (parts.length === 1) {
    const q = parts[0] ?? '';
    return list.filter((s) => {
      const teacher = resolveTeacherName(s.teacherId);
      return s.name.includes(q) || (teacher && teacher.includes(q));
    });
  }

  const subjectToken = parts[0] ?? '';
  const teacherPart = parts.slice(1).join(' ');
  return list.filter((s) => {
    if (!subjectToken || !s.name.includes(subjectToken)) return false;
    const teacher = resolveTeacherName(s.teacherId);
    if (!teacherPart) return true;
    return Boolean(teacher && teacher.includes(teacherPart));
  });
}

/** Same split as search: first word → subject name, rest → teacher name (for inline quick-add from the cell picker). */
function splitCellSearchForQuickAdd(query: string): { subject: string; teacher: string } {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (!normalized) return { subject: '', teacher: '' };
  const parts = normalized.split(' ');
  return { subject: parts[0] ?? '', teacher: parts.slice(1).join(' ') };
}

/** Printable key on a grid cell: open subject picker and prefill search (not Space/Enter — handled separately). */
function isCellTypingKey(e: React.KeyboardEvent): boolean {
  if (e.nativeEvent.isComposing) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.repeat) return false;
  if (e.key.length !== 1) return false;
  if (e.key === ' ' || e.key === '\n' || e.key === '\r') return false;
  const code = e.key.charCodeAt(0);
  if (code < 32) return false;
  return true;
}

/** Normalize to HH:MM for `type="time"`; returns '' if not parseable. */
function coerceTimeValueForInput(v: string): string {
  const t = v.trim();
  if (!t) return '';
  const m = t.match(/^(\d{1,2})\s*:\s*(\d{2})$/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  let min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return '';
  h = Math.min(23, Math.max(0, h));
  min = Math.min(59, Math.max(0, min));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function normalizeTimesRecord(raw: unknown): Record<string, PeriodTimeSlot> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, PeriodTimeSlot> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'string') {
      out[key] = { start: coerceTimeValueForInput(val), end: '' };
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const s = typeof o.start === 'string' ? coerceTimeValueForInput(o.start) : '';
      const e = typeof o.end === 'string' ? coerceTimeValueForInput(o.end) : '';
      out[key] = { start: s, end: e };
    }
  }
  return out;
}

/** Fill missing periods with standard slots; keep any period that already has a start or end set. */
function mergePeriodTimesWithDefaults(normalized: Record<string, PeriodTimeSlot>): Record<string, PeriodTimeSlot> {
  const defaults = buildStandardPeriodTimes(PERIODS);
  const out: Record<string, PeriodTimeSlot> = { ...defaults };
  for (const p of PERIODS) {
    const slot = normalized[p];
    if (slot && (slot.start || slot.end)) {
      out[p] = { start: slot.start, end: slot.end };
    }
  }
  return out;
}

function deserializeTimesRecord(parsed: unknown): Record<string, PeriodTimeSlot> {
  return mergePeriodTimesWithDefaults(normalizeTimesRecord(parsed));
}

// Custom hook for local storage
function useLocalStorage<T>(key: string, initialValue: T, deserialize?: (parsed: unknown) => T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      if (!item) return initialValue;
      const parsed = JSON.parse(item) as unknown;
      return deserialize ? deserialize(parsed) : (parsed as T);
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue, setValue] as const;
}

export default function App() {
  const [teachers, setTeachers] = useLocalStorage<Teacher[]>('scheduler_teachers_v1', []);
  const [subjects, setSubjects] = useLocalStorage<Subject[]>('scheduler_subjects_v2', []);
  const [schedule, setSchedule] = useLocalStorage<Record<string, Record<string, Record<string, string>>>>('scheduler_data_v2', {});
  const [times, setTimes] = useLocalStorage<Record<string, PeriodTimeSlot>>(
    'scheduler_times',
    buildStandardPeriodTimes(PERIODS),
    deserializeTimesRecord
  );
  const [scheduleDate, setScheduleDate] = useLocalStorage<string>(
    'scheduler_schedule_date',
    '',
    (parsed) => (typeof parsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed) ? parsed : '')
  );
  const [schoolName, setSchoolName] = useLocalStorage<string>('scheduler_school_name', '');
  const [savedTables, setSavedTables] = useLocalStorage<SavedTableEntry[]>('scheduler_saved_tables_v1', []);

  /** When set, the current editor state came from this saved entry (enables «تحديث»). */
  const [activeSavedTableId, setActiveSavedTableId] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveTableName, setSaveTableName] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  const [newTeacherName, setNewTeacherName] = useState('');
  const [editingTeacherId, setEditingTeacherId] = useState<string | null>(null);
  const [teacherNameError, setTeacherNameError] = useState('');

  const [newSubject, setNewSubject] = useState('');
  const [selectedTeacherId, setSelectedTeacherId] = useState('');
  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null);
  const [subjectPairError, setSubjectPairError] = useState('');

  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [gridFocus, setGridFocus] = useState<{ period: Period; grade: Grade }>(() => ({
    period: PERIODS[0],
    grade: ALL_GRADES[0],
  }));
  /** Non-null = rectangular selection (inclusive). Null = single-cell focus only. */
  const [rangeSelection, setRangeSelection] = useState<{ anchor: GridCoord; extent: GridCoord } | null>(null);
  const [cellSubjectFilter, setCellSubjectFilter] = useState('');
  const [cellSubjectHighlight, setCellSubjectHighlight] = useState(0);
  /** Inline «إضافة مادة» from the cell modal: first word / rest mirror cell search when not dirty. */
  const [cellQuickSubject, setCellQuickSubject] = useState('');
  const [cellQuickTeacher, setCellQuickTeacher] = useState('');
  const [cellQuickAddDirty, setCellQuickAddDirty] = useState(false);
  const [cellQuickAddError, setCellQuickAddError] = useState('');
  const [confirmState, setConfirmState] = useState<ConfirmState>({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  const tableRef = useRef<HTMLDivElement>(null);
  /** Recover from any stuck `schedule-png-export-active` on the table wrapper (hides time inputs). */
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tableRef.current?.classList.remove('schedule-png-export-active');
      });
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cellSubjectSearchRef = useRef<HTMLInputElement>(null);
  const scheduleCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const prevEditingCellRef = useRef<typeof editingCell>(null);
  const scheduleClipboardFallbackRef = useRef<string | null>(null);
  const rangeShiftAnchorRef = useRef<GridCoord>({ period: PERIODS[0], grade: ALL_GRADES[0] });
  const rangeDragAnchorRef = useRef<GridCoord | null>(null);
  const rangePointerDownRef = useRef(false);
  /** True if the current pointer gesture dragged across more than one cell (suppress single-click → picker). */
  const scheduleMultiCellDragRef = useRef(false);
  const subjectsLatestRef = useRef<Subject[]>(subjects);
  const scheduleDateLatestRef = useRef(scheduleDate);
  subjectsLatestRef.current = subjects;
  scheduleDateLatestRef.current = scheduleDate;

  const stateForUndoRef = useRef<UndoableAppSnapshot>({
    schedule,
    teachers,
    subjects,
    times,
    schoolName,
    scheduleDate,
  });
  stateForUndoRef.current = { schedule, teachers, subjects, times, schoolName, scheduleDate };

  const editingCellRef = useRef<EditingCell | null>(null);
  editingCellRef.current = editingCell;

  const undoPastRef = useRef<UndoableAppSnapshot[]>([]);
  const undoFutureRef = useRef<UndoableAppSnapshot[]>([]);
  const applyingHistoryRef = useRef(false);
  const debouncedUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MAX_UNDO_STEPS = 50;

  const cloneUndoSnapshot = (s: UndoableAppSnapshot): UndoableAppSnapshot => JSON.parse(JSON.stringify(s));

  const pushUndo = () => {
    if (applyingHistoryRef.current) return;
    const snap = cloneUndoSnapshot(stateForUndoRef.current);
    undoPastRef.current = [...undoPastRef.current.slice(-(MAX_UNDO_STEPS - 1)), snap];
    undoFutureRef.current = [];
  };

  /** One undo entry for a burst of edits (time inputs, name/date fields). */
  const pushDebouncedUndoGroup = () => {
    if (applyingHistoryRef.current) return;
    if (debouncedUndoTimerRef.current === null) {
      const snap = cloneUndoSnapshot(stateForUndoRef.current);
      undoPastRef.current = [...undoPastRef.current.slice(-(MAX_UNDO_STEPS - 1)), snap];
      undoFutureRef.current = [];
    } else {
      clearTimeout(debouncedUndoTimerRef.current);
    }
    debouncedUndoTimerRef.current = setTimeout(() => {
      debouncedUndoTimerRef.current = null;
    }, 450);
  };

  const applySnapshotFromHistory = (snap: UndoableAppSnapshot) => {
    applyingHistoryRef.current = true;
    setSchedule(snap.schedule);
    setTeachers(snap.teachers);
    setSubjects(snap.subjects);
    setTimes(snap.times);
    setSchoolName(snap.schoolName);
    setScheduleDate(snap.scheduleDate);
    queueMicrotask(() => {
      applyingHistoryRef.current = false;
    });
  };

  const performUndo = () => {
    if (applyingHistoryRef.current) return;
    const past = undoPastRef.current;
    if (past.length === 0) return;
    const prevSnap = past[past.length - 1];
    const curSnap = cloneUndoSnapshot(stateForUndoRef.current);
    undoPastRef.current = past.slice(0, -1);
    undoFutureRef.current = [...undoFutureRef.current.slice(-(MAX_UNDO_STEPS - 1)), curSnap];
    applySnapshotFromHistory(prevSnap);
  };

  const performRedo = () => {
    if (applyingHistoryRef.current) return;
    const future = undoFutureRef.current;
    if (future.length === 0) return;
    const nextSnap = future[future.length - 1];
    const curSnap = cloneUndoSnapshot(stateForUndoRef.current);
    undoFutureRef.current = future.slice(0, -1);
    undoPastRef.current = [...undoPastRef.current.slice(-(MAX_UNDO_STEPS - 1)), curSnap];
    applySnapshotFromHistory(nextSnap);
  };

  const performUndoRef = useRef(performUndo);
  const performRedoRef = useRef(performRedo);
  performUndoRef.current = performUndo;
  performRedoRef.current = performRedo;

  useEffect(() => {
    return () => {
      if (debouncedUndoTimerRef.current) clearTimeout(debouncedUndoTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== 'z') return;
      if (editingCellRef.current) return;

      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (t.isContentEditable) return;
      }

      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        performRedoRef.current();
      } else {
        performUndoRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const selectedDay = useMemo(() => isoDateToArabicWeekday(scheduleDate), [scheduleDate]);

  const teacherCollisionKeys = useMemo(
    () => teacherCollisionCellKeys(selectedDay, schedule, subjects),
    [selectedDay, schedule, subjects]
  );

  /** One-time: migrate from legacy `scheduler_dates` or set today if empty. */
  useEffect(() => {
    if (scheduleDate) return;
    try {
      const dr = window.localStorage.getItem('scheduler_dates');
      if (dr) {
        const dates = JSON.parse(dr) as Record<string, string>;
        const first = Object.values(dates).find(
          (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)
        );
        if (first) {
          setScheduleDate(first);
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setScheduleDate(todayISODate());
  }, [scheduleDate, setScheduleDate]);

  // One-time migration: string[] → subjects with `teacher`, then → teacherId + teachers list
  useEffect(() => {
    let list: unknown[] = [];
    const v2Raw = window.localStorage.getItem('scheduler_subjects_v2');
    if (v2Raw) {
      try {
        const parsed = JSON.parse(v2Raw);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        /* ignore */
      }
    }

    if (list.length === 0) {
      const oldSubjects = window.localStorage.getItem('scheduler_subjects');
      if (oldSubjects) {
        try {
          const parsed = JSON.parse(oldSubjects);
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
            list = parsed.map((s: string, i: number) => {
              const match = s.match(/(.+?)(?:\s*\((.+)\))?$/);
              return {
                id: Date.now().toString() + i,
                name: match ? match[1].trim() : s,
                teacher: match && match[2] ? match[2].trim() : '',
              };
            });
          }
        } catch (e) {
          console.error('Migration failed', e);
        }
      }
    }

    if (list.length === 0) return;

    const first = list[0];
    if (first && typeof first === 'object' && first !== null && 'teacherId' in first) {
      return;
    }

    const { teachers: migratedTeachers, subjects: migratedSubjects } = migrateLegacySubjectsToTeachers(list);
    setTeachers((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      for (const t of migratedTeachers) {
        if (!byId.has(t.id)) byId.set(t.id, t);
      }
      return Array.from(byId.values());
    });
    setSubjects(migratedSubjects);
  }, []);

  /** Merge duplicate (subject name + same teacher) rows; remap schedule cells to the kept subject id. */
  useEffect(() => {
    const { subjects: deduped, idRemap } = dedupeSubjectsByPair(subjects);
    if (idRemap.size === 0) return;
    setSubjects(deduped);
    setSchedule((s) => remapScheduleSubjectIds(s, idRemap));
  }, [subjects]);

  const confirmAction = (title: string, message: string, onConfirm: () => void) => {
    setConfirmState({ isOpen: true, title, message, onConfirm });
  };

  const closeConfirm = () => setConfirmState(prev => ({ ...prev, isOpen: false }));

  const applySnapshot = (snap: LoadedTableSnapshot) => {
    pushUndo();
    setScheduleDate(resolveSnapshotScheduleDate(snap));
    setSchoolName(typeof snap.schoolName === 'string' ? snap.schoolName : '');
    setTeachers(snap.teachers);
    setSubjects(snap.subjects);
    setSchedule(snap.schedule);
    setTimes(mergePeriodTimesWithDefaults(normalizeTimesRecord(snap.times as unknown)));
  };

  const openSaveModal = () => {
    const active = activeSavedTableId ? savedTables.find((e) => e.id === activeSavedTableId) : undefined;
    setSaveTableName(active?.name ?? '');
    setSaveModalOpen(true);
  };

  const persistNewEntry = (name: string, snap: TableSnapshot) => {
    const trimmed = name.trim() || `جدول ${new Date().toLocaleString('ar')}`;
    const now = new Date().toISOString();
    const entry: SavedTableEntry = {
      id: newEntityId(),
      name: trimmed,
      updatedAt: now,
      snapshot: snap,
    };
    setSavedTables((prev) => [entry, ...prev]);
    setActiveSavedTableId(entry.id);
  };

  const handleSaveToHistory = (mode: 'new' | 'update') => {
    const snap: TableSnapshot = buildSnapshot(
      scheduleDate || todayISODate(),
      schoolName.trim(),
      teachers,
      subjects,
      schedule,
      times
    );
    if (mode === 'update' && activeSavedTableId) {
      const trimmed = saveTableName.trim() || savedTables.find((e) => e.id === activeSavedTableId)?.name || 'جدول';
      const now = new Date().toISOString();
      setSavedTables((prev) =>
        prev.map((e) =>
          e.id === activeSavedTableId ? { ...e, name: trimmed, updatedAt: now, snapshot: snap } : e
        )
      );
      setSaveModalOpen(false);
      return;
    }
    persistNewEntry(saveTableName, snap);
    setSaveModalOpen(false);
  };

  const handleLoadSaved = (entry: SavedTableEntry) => {
    applySnapshot(entry.snapshot);
    setActiveSavedTableId(entry.id);
    setHistoryOpen(false);
    setEditingCell(null);
    setRangeSelection(null);
    setGridFocus({ period: PERIODS[0], grade: ALL_GRADES[0] });
  };

  const handleDeleteSaved = (entry: SavedTableEntry) => {
    confirmAction('حذف من السجل', `حذف «${entry.name}» من الجداول المحفوظة؟`, () => {
      setSavedTables((prev) => prev.filter((e) => e.id !== entry.id));
      if (activeSavedTableId === entry.id) setActiveSavedTableId(null);
      closeConfirm();
    });
  };

  const handleNewBlankTable = () => {
    confirmAction(
      'جدول جديد',
      'سيتم مسح الجدول الحالي من الشاشة (المعلمون، المواد، والخلايا). يمكنك حفظه في السجل أولاً من «حفظ في السجل». هل تتابع؟',
      () => {
        pushUndo();
        setScheduleDate(todayISODate());
        setTeachers([]);
        setSubjects([]);
        setSchedule({});
        setTimes(buildStandardPeriodTimes(PERIODS));
        setActiveSavedTableId(null);
        setEditingCell(null);
        setRangeSelection(null);
        setGridFocus({ period: PERIODS[0], grade: ALL_GRADES[0] });
        setEditingTeacherId(null);
        setEditingSubjectId(null);
        setNewTeacherName('');
        setNewSubject('');
        setSelectedTeacherId('');
        closeConfirm();
      }
    );
  };

  const activeSavedName = activeSavedTableId
    ? savedTables.find((e) => e.id === activeSavedTableId)?.name
    : null;

  const teacherNameById = (id: string) => (id ? teachers.find((t) => t.id === id)?.name : '') ?? '';

  const filteredCellSubjects = useMemo(
    () => subjectsMatchingCellFilter(subjects, cellSubjectFilter, teacherNameById),
    [subjects, cellSubjectFilter, teachers]
  );

  /** No rows in the picker: offer inline add (empty catalog, or search narrowed to zero). */
  const showCellQuickAdd = useMemo(
    () =>
      filteredCellSubjects.length === 0 &&
      (subjects.length === 0 || cellSubjectFilter.trim().length > 0),
    [filteredCellSubjects.length, subjects.length, cellSubjectFilter]
  );

  useEffect(() => {
    if (!editingCell) return;
    const initialFilter = editingCell.filterPrefill ?? '';
    setCellSubjectFilter(initialFilter);
    setCellQuickAddError('');
    const filteredForHighlight = subjectsMatchingCellFilter(subjects, initialFilter, teacherNameById);
    const currentId = schedule[editingCell.day]?.[editingCell.period]?.[editingCell.grade] ?? '';
    const idx = currentId ? filteredForHighlight.findIndex((s) => s.id === currentId) : -1;
    setCellSubjectHighlight(idx >= 0 ? idx : 0);
    const id = window.requestAnimationFrame(() => {
      cellSubjectSearchRef.current?.focus();
      cellSubjectSearchRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [editingCell, schedule, subjects, teachers]);

  useEffect(() => {
    setCellQuickAddDirty(false);
  }, [cellSubjectFilter]);

  useEffect(() => {
    if (!editingCell) return;
    if (filteredCellSubjects.length > 0) return;
    if (cellQuickAddDirty) return;
    const { subject, teacher } = splitCellSearchForQuickAdd(cellSubjectFilter);
    setCellQuickSubject(subject);
    setCellQuickTeacher(teacher);
  }, [cellSubjectFilter, editingCell, filteredCellSubjects.length, cellQuickAddDirty]);

  useEffect(() => {
    setCellSubjectHighlight((i) =>
      filteredCellSubjects.length === 0 ? 0 : Math.min(i, filteredCellSubjects.length - 1)
    );
  }, [filteredCellSubjects.length]);

  useEffect(() => {
    const wasOpen = prevEditingCellRef.current;
    prevEditingCellRef.current = editingCell;
    if (wasOpen !== null && editingCell === null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = scheduleCellRefs.current.get(scheduleCellStorageKey(gridFocus.period, gridFocus.grade));
          el?.focus({ preventScroll: true });
        });
      });
    }
  }, [editingCell, gridFocus]);

  useEffect(() => {
    const endDrag = () => {
      rangePointerDownRef.current = false;
      rangeDragAnchorRef.current = null;
      window.setTimeout(() => {
        scheduleMultiCellDragRef.current = false;
      }, 0);
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, []);

  const handleSaveTeacher = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizeTeacherNameKey(newTeacherName);
    if (!normalized) return;

    const duplicate = teachers.some(
      (t) =>
        normalizeTeacherNameKey(t.name) === normalized &&
        t.id !== editingTeacherId
    );
    if (duplicate) {
      setTeacherNameError('يوجد معلم مسجّل بنفس الاسم. اختر اسماً مختلفاً أو عدّل المعلم الحالي.');
      return;
    }
    setTeacherNameError('');

    if (editingTeacherId) {
      pushUndo();
      setTeachers((prev) =>
        prev.map((t) => (t.id === editingTeacherId ? { ...t, name: normalized } : t))
      );
      setEditingTeacherId(null);
    } else {
      pushUndo();
      setTeachers((prev) => [...prev, { id: newEntityId(), name: normalized }]);
    }
    setNewTeacherName('');
  };

  const handleEditTeacher = (t: Teacher) => {
    setTeacherNameError('');
    setEditingTeacherId(t.id);
    setNewTeacherName(t.name);
  };

  const handleCancelEditTeacher = () => {
    setEditingTeacherId(null);
    setNewTeacherName('');
    setTeacherNameError('');
  };

  const handleDeleteTeacher = (t: Teacher) => {
    confirmAction(
      'حذف معلم',
      `هل أنت متأكد من حذف "${t.name}"؟ ستُزال ربطه من المواد التي يدرّسها.`,
      () => {
        pushUndo();
        setTeachers((prev) => prev.filter((x) => x.id !== t.id));
        setSubjects((prev) =>
          prev.map((s) => (s.teacherId === t.id ? { ...s, teacherId: '' } : s))
        );
        if (selectedTeacherId === t.id) setSelectedTeacherId('');
        closeConfirm();
      }
    );
  };

  const handleSaveSubject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubject.trim()) return;

    const tid = selectedTeacherId && teachers.some((t) => t.id === selectedTeacherId) ? selectedTeacherId : '';
    const normalizedName = normalizeSubjectNameKey(newSubject);

    const duplicate = subjects.some(
      (s) =>
        normalizeSubjectNameKey(s.name) === normalizedName &&
        (s.teacherId || '') === tid &&
        s.id !== editingSubjectId
    );
    if (duplicate) {
      setSubjectPairError(
        'لا يمكن تكرار نفس المادة مع نفس المعلم. يمكنك إضافة المادة مع معلم آخر أو بدون معلم.'
      );
      return;
    }
    setSubjectPairError('');

    if (editingSubjectId) {
      pushUndo();
      setSubjects((prev) =>
        prev.map((s) => (s.id === editingSubjectId ? { ...s, name: newSubject.trim(), teacherId: tid } : s))
      );
      setEditingSubjectId(null);
    } else {
      pushUndo();
      setSubjects((prev) => [
        ...prev,
        {
          id: newEntityId(),
          name: newSubject.trim(),
          teacherId: tid,
        },
      ]);
    }
    setNewSubject('');
    setSelectedTeacherId('');
  };

  /** Create teacher (if needed), subject, assign current cell — one undo step. */
  const handleQuickAddSubjectAndAssign = () => {
    if (!editingCell) return;
    const normalizedName = normalizeSubjectNameKey(cellQuickSubject);
    if (!normalizedName) {
      setCellQuickAddError('أدخل اسم المادة.');
      return;
    }
    const teacherNameRaw = normalizeTeacherNameKey(cellQuickTeacher);
    let teacherId = '';
    let nextTeachers = teachers;
    if (teacherNameRaw) {
      const existing = teachers.find((t) => normalizeTeacherNameKey(t.name) === teacherNameRaw);
      if (existing) {
        teacherId = existing.id;
      } else {
        teacherId = newEntityId();
        nextTeachers = [...teachers, { id: teacherId, name: teacherNameRaw }];
      }
    }
    const duplicate = subjects.some(
      (s) =>
        normalizeSubjectNameKey(s.name) === normalizedName &&
        (s.teacherId || '') === teacherId
    );
    if (duplicate) {
      setCellQuickAddError(
        'توجد مادة بنفس الاسم ونفس المعلم. اخترها من القائمة أو عيّن معلماً مختلفاً.'
      );
      return;
    }
    setCellQuickAddError('');
    const newId = newEntityId();
    const { day, period, grade } = editingCell;
    pushUndo();
    if (nextTeachers.length > teachers.length) {
      setTeachers(nextTeachers);
    }
    setSubjects((prev) => [...prev, { id: newId, name: normalizedName, teacherId }]);
    setSchedule((prev) => {
      const next = { ...prev };
      if (!next[day]) next[day] = {};
      if (!next[day][period]) next[day][period] = {};
      next[day] = { ...next[day], [period]: { ...next[day][period], [grade]: newId } };
      return next;
    });
    setEditingCell(null);
  };

  const handleEditSubject = (subject: Subject) => {
    setSubjectPairError('');
    setEditingSubjectId(subject.id);
    setNewSubject(subject.name);
    setSelectedTeacherId(subject.teacherId && teachers.some((t) => t.id === subject.teacherId) ? subject.teacherId : '');
  };

  const handleCancelEdit = () => {
    setEditingSubjectId(null);
    setNewSubject('');
    setSelectedTeacherId('');
    setSubjectPairError('');
  };

  const handleDeleteSubject = (subject: Subject) => {
    confirmAction(
      'حذف مادة',
      `هل أنت متأكد من حذف مادة "${subject.name}"؟ لن يتم حذفها من الجدول المحفوظ مسبقاً.`,
      () => {
        pushUndo();
        setSubjects(prev => prev.filter(s => s.id !== subject.id));
        closeConfirm();
      }
    );
  };

  const handleExportSubjects = () => {
    const payload = { version: 2 as const, teachers, subjects };
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', dataStr);
    downloadAnchorNode.setAttribute('download', 'subjects_teachers.json');
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleImportSubjects = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) {
          const valid = imported.filter((i: LegacySubjectRow) => i && i.id && i.name);
          if (valid.length === 0) return;
          pushUndo();
          const { teachers: impTeachers, subjects: rawSubs } = migrateLegacySubjectsToTeachers(valid);
          const { subjects: impSubjects, idRemap } = dedupeSubjectsByPair(rawSubs);
          setTeachers(impTeachers);
          setSubjects(impSubjects);
          if (idRemap.size > 0) {
            setSchedule((s) => remapScheduleSubjectIds(s, idRemap));
          }
        } else if (imported && typeof imported === 'object' && Array.isArray(imported.subjects)) {
          pushUndo();
          const tList = Array.isArray(imported.teachers) ? imported.teachers : [];
          const validTeachers = tList
            .filter((t: Teacher) => t && t.id && t.name)
            .map((t: Teacher) => ({ id: String(t.id), name: String(t.name) }));
          const { teachers: merged, subjects: rawSubs } = normalizeSubjectImport(
            imported.subjects as unknown[],
            validTeachers
          );
          const { subjects: impSubjects, idRemap } = dedupeSubjectsByPair(rawSubs);
          setTeachers(merged);
          setSubjects(impSubjects);
          if (idRemap.size > 0) {
            setSchedule((s) => remapScheduleSubjectIds(s, idRemap));
          }
        }
      } catch (err) {
        console.error('Invalid JSON file', err);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handlePeriodTimeChange = (period: Period, field: 'start' | 'end', value: string) => {
    pushDebouncedUndoGroup();
    setTimes((prev) => {
      const slot = prev[period] ?? { start: '', end: '' };
      return { ...prev, [period]: { ...slot, [field]: value } };
    });
  };

  /** Move grid focus and focus the DOM cell after React commits (double rAF avoids Strict Mode / layout races). */
  const focusScheduleCell = (period: Period, grade: Grade) => {
    setGridFocus({ period, grade });
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scheduleCellRefs.current.get(scheduleCellStorageKey(period, grade))?.focus({ preventScroll: true });
      });
    });
  };

  const openCellEditor = (day: Day, period: Period, grade: Grade, filterPrefill?: string) => {
    setGridFocus({ period, grade });
    setEditingCell(
      filterPrefill !== undefined ? { day, period, grade, filterPrefill } : { day, period, grade }
    );
  };

  const clearScheduleCellAt = (day: Day, period: Period, grade: Grade) => {
    if (!(schedule[day]?.[period]?.[grade])) return;
    pushUndo();
    setSchedule((prev) => {
      const next = { ...prev };
      if (next[day]?.[period]) {
        const row = { ...next[day][period] };
        delete row[grade];
        next[day] = { ...next[day], [period]: row };
      }
      return next;
    });
  };

  const pasteScheduleFromClipboard = async (period: Period, grade: Grade) => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      /* use in-app fallback */
    }
    const fallback = scheduleClipboardFallbackRef.current ?? '';
    const rangePayload = parseScheduleRangeClipboard(text) ?? parseScheduleRangeClipboard(fallback);
    if (rangePayload) {
      const subs = subjectsLatestRef.current;
      const valid = new Set(subs.map((s) => s.id));
      const day = isoDateToArabicWeekday(scheduleDateLatestRef.current || todayISODate());
      pushUndo();
      setSchedule((prev) => applyScheduleRangePaste(day, period, grade, rangePayload, valid, prev));
      return;
    }

    let subjectId = parseScheduleCellClipboard(text);
    if (subjectId === null) {
      subjectId = parseScheduleCellClipboard(fallback);
    }
    if (subjectId === null) return;

    const subs = subjectsLatestRef.current;
    if (subjectId !== '' && !subs.some((s) => s.id === subjectId)) return;

    const day = isoDateToArabicWeekday(scheduleDateLatestRef.current || todayISODate());
    pushUndo();
    setSchedule((prev) => {
      const next = { ...prev };
      if (!next[day]) next[day] = {};
      if (!next[day][period]) next[day][period] = {};
      const row = { ...next[day][period] };
      if (subjectId === '') {
        delete row[grade];
      } else {
        row[grade] = subjectId;
      }
      next[day] = { ...next[day], [period]: row };
      return next;
    });
  };

  const handleScheduleCellKeyDown = (
    e: React.KeyboardEvent<HTMLTableCellElement>,
    period: Period,
    grade: Grade
  ) => {
    const pi = PERIODS.indexOf(period);
    const gi = ALL_GRADES.indexOf(grade);

    if (e.key === 'Escape') {
      if (rangeSelection) {
        e.preventDefault();
        setRangeSelection(null);
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      const day = selectedDay;
      let matrix: string[][];
      if (rangeSelection) {
        const m = buildScheduleRangeMatrix(day, rangeSelection.anchor, rangeSelection.extent, schedule);
        matrix = m ?? [[schedule[day]?.[period]?.[grade] ?? '']];
      } else {
        matrix = [[schedule[day]?.[period]?.[grade] ?? '']];
      }
      const payload = stringifyScheduleRangeClipboard(matrix);
      scheduleClipboardFallbackRef.current = payload;
      void navigator.clipboard.writeText(payload).catch(() => {});
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      void pasteScheduleFromClipboard(period, grade);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (rangeSelection) {
        const box = selectionBBox(rangeSelection.anchor, rangeSelection.extent);
        if (box) {
          e.preventDefault();
          const day = selectedDay;
          pushUndo();
          setSchedule((prev) => {
            const next = { ...prev };
            const nextDay = { ...(next[day] ?? {}) };
            for (let rpi = box.minPi; rpi <= box.maxPi; rpi++) {
              const p = PERIODS[rpi];
              const periodRow = { ...(nextDay[p] ?? {}) };
              for (let rgi = box.minGi; rgi <= box.maxGi; rgi++) {
                delete periodRow[ALL_GRADES[rgi]];
              }
              nextDay[p] = periodRow;
            }
            next[day] = nextDay;
            return next;
          });
        }
        return;
      }
      const subjectId = schedule[selectedDay]?.[period]?.[grade] ?? '';
      if (!subjectId) return;
      e.preventDefault();
      clearScheduleCellAt(selectedDay, period, grade);
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setRangeSelection(null);
      if (pi < PERIODS.length - 1) {
        focusScheduleCell(PERIODS[pi + 1], grade);
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setRangeSelection(null);
      if (pi > 0) {
        focusScheduleCell(PERIODS[pi - 1], grade);
      }
      return;
    }
    // RTL layout: physical ArrowLeft moves toward the visual start side (higher grade index here).
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setRangeSelection(null);
      if (gi < ALL_GRADES.length - 1) {
        focusScheduleCell(period, ALL_GRADES[gi + 1]);
      }
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      setRangeSelection(null);
      if (gi > 0) {
        focusScheduleCell(period, ALL_GRADES[gi - 1]);
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openCellEditor(selectedDay, period, grade);
      return;
    }
    if (isCellTypingKey(e)) {
      e.preventDefault();
      openCellEditor(selectedDay, period, grade, e.key);
    }
  };

  const handleSelectSubject = (subjectId: string) => {
    if (!editingCell) return;
    const { day, period, grade } = editingCell;

    pushUndo();
    setSchedule(prev => {
      const newSchedule = { ...prev };
      if (!newSchedule[day]) newSchedule[day] = {};
      if (!newSchedule[day][period]) newSchedule[day][period] = {};
      
      newSchedule[day][period][grade] = subjectId;
      return newSchedule;
    });
    
    setEditingCell(null);
  };

  const handleClearCell = () => {
    if (!editingCell) return;
    confirmAction(
      'تفريغ الحصة',
      'هل أنت متأكد من تفريغ هذه الحصة؟',
      () => {
        const { day, period, grade } = editingCell;
        pushUndo();
        setSchedule(prev => {
          const newSchedule = { ...prev };
          if (newSchedule[day] && newSchedule[day][period]) {
            delete newSchedule[day][period][grade];
          }
          return newSchedule;
        });
        setEditingCell(null);
        closeConfirm();
      }
    );
  };

  const handleDownloadImage = async () => {
    if (!tableRef.current) return;
    const root = tableRef.current;
    const day = selectedDay;

    /** PNG includes only periods with at least one subject; time alone does not count as content. */
    const periodRowHasExportContent = (p: Period) =>
      ALL_GRADES.some((g) => Boolean(schedule[day]?.[p]?.[g]));

    const periodsForExport = PERIODS.filter(periodRowHasExportContent);

    const gradesForExport = ALL_GRADES.filter((g) =>
      periodsForExport.some((p) => Boolean(schedule[day]?.[p]?.[g]))
    );

    const hiddenEls: HTMLElement[] = [];
    const markHidden = (el: HTMLElement | null) => {
      if (!el) return;
      el.classList.add(SCHEDULE_PNG_EXPORT_HIDE_CLASS);
      hiddenEls.push(el);
    };

    try {
      root.querySelectorAll<HTMLElement>('tr[data-export-period]').forEach((row) => {
        const p = row.dataset.exportPeriod as Period;
        if (!periodsForExport.includes(p)) {
          markHidden(row);
        }
      });
      root.querySelectorAll<HTMLElement>('[data-export-grade]').forEach((el) => {
        const g = el.dataset.exportGrade as Grade;
        if (!gradesForExport.includes(g)) {
          markHidden(el);
        }
      });

      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );

      const dataUrl = await toPng(root, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      });

      const link = document.createElement('a');
      const iso = scheduleDate || todayISODate();
      link.download = `جدول-${selectedDay}-${iso}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Error generating image', err);
    } finally {
      hiddenEls.forEach((el) => el.classList.remove(SCHEDULE_PNG_EXPORT_HIDE_CLASS));
    }
  };

  return (
    <div
      className="app-shell min-h-svh min-h-dvh text-stone-900 font-sans text-base leading-relaxed antialiased pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(0.5rem,env(safe-area-inset-top))]"
      dir="rtl"
    >
      {/* Header */}
      <header className="print:hidden border-b border-stone-800/80 bg-gradient-to-b from-stone-950 to-stone-900 text-white shadow-[0_4px_24px_-4px_rgba(0,0,0,0.35)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-5 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
          <div className="flex items-center gap-3 min-w-0">
            <Calendar className="h-8 w-8 sm:h-9 sm:w-9 shrink-0 text-teal-300" aria-hidden />
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight leading-snug text-white">
              صانع الجداول المدرسية
            </h1>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8 space-y-7 sm:space-y-8">
        {/* Saved tables toolbar */}
        <div className="print:hidden overflow-hidden rounded-2xl border border-stone-200/90 bg-white/90 shadow-[0_1px_0_0_rgba(255,255,255,0.8)_inset,0_8px_32px_-12px_rgba(15,23,42,0.12)] backdrop-blur-sm">
          <div className="flex flex-col gap-5 p-5 sm:p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3 sm:items-center">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-teal-600 text-white shadow-md shadow-teal-900/20 ring-4 ring-teal-600/15">
                <History className="h-6 w-6" strokeWidth={2} aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-lg font-extrabold text-stone-900">سجل الجداول</p>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${
                      activeSavedName
                        ? 'bg-teal-100 text-teal-900 ring-1 ring-teal-200/80'
                        : 'bg-stone-100 text-stone-600 ring-1 ring-stone-200/80'
                    }`}
                  >
                    {activeSavedName ? 'من السجل' : 'مسودة'}
                  </span>
                </div>
                <p className="mt-1.5 text-base leading-relaxed text-stone-600 sm:truncate">
                  {activeSavedName
                    ? `تعديل: ${activeSavedName}`
                    : 'لم يُحمّل جدول من السجل — التعديلات على النسخة الحالية فقط'}
                </p>
              </div>
            </div>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-end">
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-5 py-3 text-base font-bold text-stone-800 shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-50 touch-manipulation sm:w-auto"
              >
                <FolderOpen className="h-5 w-5 shrink-0 text-stone-500" aria-hidden />
                <span>فتح السجل</span>
              </button>
              <button
                type="button"
                onClick={openSaveModal}
                className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-base font-bold text-white shadow-md shadow-teal-900/20 transition-colors hover:bg-teal-700 touch-manipulation sm:w-auto"
              >
                <Save className="h-5 w-5 shrink-0" aria-hidden />
                <span>حفظ في السجل</span>
              </button>
              <button
                type="button"
                onClick={handleNewBlankTable}
                className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl border border-amber-200/90 bg-amber-50 px-5 py-3 text-base font-bold text-amber-950 transition-colors hover:bg-amber-100 touch-manipulation sm:w-auto"
              >
                <FilePlus2 className="h-4 w-4 shrink-0 text-amber-700" />
                <span>جدول جديد</span>
              </button>
            </div>
          </div>
        </div>

        {/* Settings & Subjects Section */}
        <section className="rounded-2xl border border-stone-200/80 bg-white p-5 shadow-[0_2px_16px_-4px_rgba(15,23,42,0.08)] ring-1 ring-stone-200/40 sm:p-6 print:hidden">
          <div className="mb-6 flex flex-col gap-4 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-stone-100 text-teal-700 ring-1 ring-stone-200/80">
                <Settings className="h-7 w-7 sm:h-7 sm:w-7" strokeWidth={2} aria-hidden />
              </span>
              <h2 className="text-xl font-extrabold leading-tight text-stone-900 sm:text-2xl">
                إدارة المواد والمعلمين
              </h2>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:gap-3 w-full sm:w-auto">
              <button
                type="button"
                onClick={handleExportSubjects}
                className="flex w-full sm:w-auto items-center justify-center gap-2 px-5 py-3 min-h-[52px] text-base bg-stone-50 text-stone-700 hover:bg-teal-50 rounded-xl font-semibold transition-colors touch-manipulation"
              >
                <Download className="h-5 w-5 shrink-0" aria-hidden />
                <span>تصدير</span>
              </button>
              <label className="flex w-full sm:w-auto items-center justify-center gap-2 px-5 py-3 min-h-[52px] text-base bg-stone-50 text-stone-700 hover:bg-teal-50 rounded-xl font-semibold transition-colors cursor-pointer touch-manipulation">
                <Upload className="h-5 w-5 shrink-0" aria-hidden />
                <span>استيراد</span>
                <input
                  type="file"
                  accept=".json"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleImportSubjects}
                />
              </label>
            </div>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-10">
            {/* Teachers */}
            <div className="lg:col-span-1 rounded-2xl border border-stone-200/80 border-l-4 border-l-teal-600 bg-gradient-to-br from-stone-50 to-white p-5 sm:p-6 shadow-sm">
              <h3 className="mb-5 flex items-center space-x-2 space-x-reverse text-lg sm:text-xl font-bold text-stone-900">
                <Users className="h-6 w-6 text-teal-600 shrink-0" aria-hidden />
                <span>{editingTeacherId ? 'تعديل معلم' : 'المعلمون'}</span>
              </h3>
              <form onSubmit={handleSaveTeacher} className="space-y-4">
                <div>
                  <label className="block text-base font-bold text-stone-800 mb-2">اسم المعلم</label>
                  <input
                    type="text"
                    value={newTeacherName}
                    onChange={(e) => {
                      setNewTeacherName(e.target.value);
                      setTeacherNameError('');
                    }}
                    className={`w-full min-h-[48px] rounded-xl px-4 py-3 text-base shadow-sm outline-none transition-all focus:ring-2 focus:ring-teal-500 focus:border-teal-500 ${
                      teacherNameError
                        ? 'border border-red-300 ring-1 ring-red-200/80'
                        : 'border border-stone-200'
                    }`}
                    placeholder="أضف معلماً مرة واحدة ثم اربطه بعدة مواد"
                    required
                    aria-invalid={teacherNameError ? true : undefined}
                    aria-describedby={teacherNameError ? 'teacher-name-error' : undefined}
                  />
                  {teacherNameError ? (
                    <p id="teacher-name-error" className="mt-2 text-base font-medium text-red-600" role="alert">
                      {teacherNameError}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:gap-3 sm:space-x-3 sm:space-x-reverse pt-2">
                  <button
                    type="submit"
                    className="flex-1 flex justify-center items-center min-h-[52px] space-x-2 space-x-reverse bg-teal-600 hover:bg-teal-700 text-white px-4 py-3 rounded-xl transition-colors text-base font-bold shadow-sm shadow-teal-900/15 touch-manipulation"
                  >
                    {editingTeacherId ? <Check className="h-5 w-5" aria-hidden /> : <Plus className="h-5 w-5" aria-hidden />}
                    <span>{editingTeacherId ? 'حفظ' : 'إضافة معلم'}</span>
                  </button>
                  {editingTeacherId && (
                    <button
                      type="button"
                      onClick={handleCancelEditTeacher}
                      className="rounded-xl border border-stone-200 bg-white px-5 py-3 min-h-[52px] font-bold text-stone-700 text-base shadow-sm transition-colors hover:bg-stone-50 touch-manipulation"
                    >
                      إلغاء
                    </button>
                  )}
                </div>
              </form>
              {teachers.length > 0 && (
                <ul className="mt-5 space-y-3 max-h-[min(320px,50vh)] overflow-y-auto pr-1">
                  {teachers.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between gap-3 bg-white p-3 sm:p-4 rounded-xl border border-stone-200/80 shadow-sm"
                    >
                      <span className="font-medium text-stone-900 text-base truncate min-w-0">{t.name}</span>
                      <div className="flex shrink-0 space-x-1 space-x-reverse">
                        <button
                          type="button"
                          onClick={() => handleEditTeacher(t)}
                          className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl text-teal-600 transition-colors hover:bg-teal-50 touch-manipulation"
                          aria-label={`تعديل ${t.name}`}
                        >
                          <Edit2 className="h-5 w-5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTeacher(t)}
                          className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl text-red-600 transition-colors hover:bg-red-50 touch-manipulation"
                          aria-label={`حذف ${t.name}`}
                        >
                          <Trash2 className="h-5 w-5" aria-hidden />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Add/Edit Subject Form */}
            <div className="lg:col-span-1 rounded-2xl border border-stone-200/80 bg-stone-50/90 p-5 sm:p-6 shadow-sm ring-1 ring-stone-100">
              <h3 className="mb-5 text-lg sm:text-xl font-bold text-stone-900">
                {editingSubjectId ? 'تعديل المادة' : 'إضافة مادة جديدة'}
              </h3>
              <form onSubmit={handleSaveSubject} className="space-y-4">
                <div>
                  <label className="block text-base font-bold text-stone-800 mb-2">المادة (مثال: رياضيات)</label>
                  <input
                    type="text"
                    value={newSubject}
                    onChange={(e) => {
                      setNewSubject(e.target.value);
                      setSubjectPairError('');
                    }}
                    className={`w-full min-h-[48px] px-4 py-3 text-base border rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all shadow-sm ${
                      subjectPairError ? 'border-red-300 ring-1 ring-red-200/80' : 'border-stone-200'
                    }`}
                    placeholder="اسم المادة"
                    required
                    aria-invalid={subjectPairError ? true : undefined}
                    aria-describedby={subjectPairError ? 'subject-pair-error' : undefined}
                  />
                  {subjectPairError ? (
                    <p id="subject-pair-error" className="mt-2 text-base font-medium text-red-600" role="alert">
                      {subjectPairError}
                    </p>
                  ) : null}
                </div>
                <div>
                  <label className="block text-base font-bold text-stone-800 mb-2">المعلم (اختياري)</label>
                  <select
                    value={selectedTeacherId}
                    onChange={(e) => {
                      setSelectedTeacherId(e.target.value);
                      setSubjectPairError('');
                    }}
                    className="w-full min-h-[48px] px-4 py-3 text-base border border-stone-200 rounded-xl focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none transition-all shadow-sm bg-white text-stone-900"
                  >
                    <option value="">— بدون معلم —</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  {teachers.length === 0 && (
                    <p className="text-sm text-stone-600 mt-2 leading-relaxed">أضف معلماً من قسم «المعلمون» أولاً لربطه بالمادة.</p>
                  )}
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:gap-3 sm:space-x-3 sm:space-x-reverse pt-2">
                  <button
                    type="submit"
                    className="flex-1 flex justify-center items-center min-h-[52px] space-x-2 space-x-reverse bg-teal-600 hover:bg-teal-700 text-white px-4 py-3 rounded-xl transition-colors text-base font-bold shadow-sm shadow-teal-900/15 touch-manipulation"
                  >
                    {editingSubjectId ? <Check className="h-5 w-5" aria-hidden /> : <Plus className="h-5 w-5" aria-hidden />}
                    <span>{editingSubjectId ? 'حفظ التعديلات' : 'إضافة للقائمة'}</span>
                  </button>
                  {editingSubjectId && (
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      className="rounded-xl border border-stone-200 bg-white px-5 py-3 min-h-[52px] text-base font-bold text-stone-700 shadow-sm transition-colors hover:bg-stone-50 touch-manipulation"
                    >
                      إلغاء
                    </button>
                  )}
                </div>
              </form>
            </div>

            {/* Subjects List */}
            <div className="lg:col-span-1">
              <h3 className="text-lg sm:text-xl font-bold mb-5 text-stone-900 flex items-center space-x-2 space-x-reverse gap-2">
                <BookOpen className="h-6 w-6 text-stone-500 shrink-0" aria-hidden />
                <span>المواد المضافة ({subjects.length})</span>
              </h3>
              {subjects.length === 0 ? (
                <div className="text-center py-12 px-4 bg-stone-50/90 rounded-2xl border-2 border-dashed border-stone-200 text-stone-500 font-medium text-base leading-relaxed">
                  لم يتم إضافة أي مواد بعد. استخدم النموذج لإضافة المواد.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 max-h-[min(380px,55vh)] overflow-y-auto p-1">
                  {subjects.map((subject) => (
                    <div key={subject.id} className="flex flex-col bg-white p-4 sm:p-5 rounded-xl border border-stone-200/80 shadow-sm hover:shadow-md transition-shadow">
                      <div className="font-bold text-stone-900 text-lg leading-snug">{subject.name}</div>
                      <div className="text-base text-stone-600 mb-4 mt-1">
                        {subject.teacherId ? teacherNameById(subject.teacherId) || '(معلم محذوف)' : 'بدون معلم'}
                      </div>
                      <div className="flex justify-end gap-2 mt-auto pt-3 border-t border-stone-100">
                        <button 
                          type="button"
                          onClick={() => handleEditSubject(subject)} 
                          className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl text-teal-600 transition-colors hover:bg-teal-50 touch-manipulation"
                          aria-label={`تعديل مادة ${subject.name}`}
                        >
                          <Edit2 className="h-5 w-5" aria-hidden />
                        </button>
                        <button 
                          type="button"
                          onClick={() => handleDeleteSubject(subject)} 
                          className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-xl text-red-600 transition-colors hover:bg-red-50 touch-manipulation"
                          aria-label={`حذف مادة ${subject.name}`}
                        >
                          <Trash2 className="h-5 w-5" aria-hidden />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Schedule Section */}
        <section className="overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-[0_2px_16px_-4px_rgba(15,23,42,0.08)] ring-1 ring-stone-200/40">
          {/* Controls */}
          <div className="border-b border-stone-200/80 bg-gradient-to-b from-stone-50 to-stone-50/50 p-5 print:hidden sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
              <div className="flex w-full flex-1 min-w-0 flex-col gap-4">
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-3 bg-white p-4 rounded-xl border border-stone-200/80 shadow-sm">
                  <label
                    htmlFor="school-name"
                    className="text-sm sm:text-base font-bold text-stone-900 whitespace-nowrap px-1 shrink-0"
                  >
                    اسم المدرسة:
                  </label>
                  <input
                    id="school-name"
                    type="text"
                    value={schoolName}
                    onChange={(e) => {
                      pushDebouncedUndoGroup();
                      setSchoolName(e.target.value);
                    }}
                    placeholder="يظهر أعلى الجدول وفي صورة PNG"
                    className="w-full min-w-0 min-h-[48px] rounded-lg border border-stone-200 bg-stone-50/90 px-4 py-3 text-base focus:ring-2 focus:ring-teal-500 focus:border-teal-500 outline-none text-stone-900 font-medium"
                  />
                </div>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-3 bg-white p-4 rounded-xl border border-stone-200/80 shadow-sm">
                  <label
                    htmlFor="schedule-date"
                    className="text-sm sm:text-base font-bold text-stone-900 whitespace-nowrap px-1 shrink-0"
                  >
                    تاريخ الجدول:
                  </label>
                  <input
                    id="schedule-date"
                    type="date"
                    value={scheduleDate || ''}
                    onChange={(e) => {
                      pushDebouncedUndoGroup();
                      setScheduleDate(e.target.value);
                    }}
                    className="w-full min-w-0 min-h-[48px] border-none bg-stone-50/90 rounded-lg px-4 py-3 text-base focus:ring-2 focus:ring-teal-500 outline-none text-stone-900 font-medium"
                  />
                  <p className="text-sm sm:text-base text-stone-600 sm:mr-2 sm:mt-0 mt-1 leading-relaxed">
                    يوم العرض: <span className="font-bold text-stone-800">{selectedDay}</span> (يُستخرج من التاريخ)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDownloadImage}
                className="inline-flex min-h-[52px] w-full lg:w-auto shrink-0 items-center justify-center gap-2 rounded-xl bg-teal-600 px-5 sm:px-6 py-3 text-base font-bold text-white shadow-md shadow-teal-900/20 transition-colors hover:bg-teal-700 touch-manipulation"
              >
                <ImageIcon className="h-6 w-6 shrink-0 opacity-95" aria-hidden />
                <span>تحميل الجدول كصورة PNG</span>
              </button>
            </div>
            <p className="mt-4 text-center text-sm text-stone-600 leading-relaxed print:hidden sm:hidden">
              للتمرير أفقياً على الجدول، مرّر بإصبعك يميناً ويساراً داخل المنطقة المخطّطة.
            </p>
            <details className="mt-4 print:hidden group rounded-xl border border-stone-200/90 bg-white/80 px-4 py-3 text-stone-700 shadow-sm open:shadow-md">
              <summary className="cursor-pointer list-none text-base font-bold text-stone-800 outline-none select-none [&::-webkit-details-marker]:hidden flex items-center justify-between gap-2 touch-manipulation min-h-[48px] py-1">
                <span>مساعدة: لوحة المفاتيح والتحديد</span>
                <span className="text-stone-400 text-sm font-normal group-open:rotate-180 transition-transform" aria-hidden>
                  ▼
                </span>
              </summary>
              <p className="mt-3 text-sm sm:text-base text-stone-600 leading-relaxed border-t border-stone-100 pt-3">
                تحديد عدة خلايا: اسحب من خلية إلى أخرى، أو انقر خلية ثم{' '}
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  Shift
                </kbd>
                +نقر لتوسيع المستطيل. النسخ/اللصق: ركّز الخلية التي يبدأ منها اللصق ثم{' '}
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  ⌘C
                </kbd>
                /
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  Ctrl+C
                </kbd>
                {' '}و
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  ⌘V
                </kbd>
                /
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  Ctrl+V
                </kbd>
                . التراجع / الإعادة خارج حقول النص:{' '}
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  ⌘Z
                </kbd>
                /
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  Ctrl+Z
                </kbd>
                {' '}و
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  ⇧⌘Z
                </kbd>
                /
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  Ctrl+Shift+Z
                </kbd>
                .{' '}
                <kbd className="rounded border border-stone-200 bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700">
                  Esc
                </kbd>
                يلغي التحديد المتعدد.
              </p>
            </details>
          </div>

          {/* Table Container for Image Export */}
          <div className="schedule-scroll overflow-x-auto overflow-y-visible bg-white touch-pan-x scroll-smooth">
            <div ref={tableRef} className="min-w-max p-4 sm:p-8 bg-white">
              {/* Header for Image/Print */}
              <div className="text-center mb-5 sm:mb-8 px-2">
                {schoolName.trim() ? (
                  <p className="text-xl sm:text-2xl font-extrabold text-stone-900 mb-2 sm:mb-3 leading-tight tracking-tight">
                    {schoolName.trim()}
                  </p>
                ) : null}
                <h2 className="text-2xl sm:text-3xl font-bold text-stone-900 mb-2 sm:mb-2 leading-snug">
                  الجدول المدرسي - {selectedDay}
                </h2>
                {scheduleDate ? (
                  <h3 className="text-lg font-semibold text-teal-700 sm:text-xl">
                    {formatISODateArabicLong(scheduleDate)}
                  </h3>
                ) : null}
              </div>

              <table
                role="grid"
                aria-label={`جدول الحصص — ${selectedDay}`}
                className="w-full select-none text-right border-separate border-spacing-0 text-base sm:text-base"
              >
                <thead>
                  <tr className="border-b-2 border-stone-200 bg-stone-100 text-stone-900">
                    <th className="sticky right-0 z-30 w-[5.75rem] min-w-[5.75rem] border-l border-stone-200 bg-stone-100 p-2.5 text-center text-sm sm:text-base font-bold shadow-[inset_-6px_0_8px_-6px_rgba(0,0,0,0.06)] sm:w-24 sm:min-w-[6rem] sm:p-4 sm:text-lg">
                      الحصة
                    </th>
                    <th className="sticky right-[5.75rem] sm:right-24 z-20 w-[8.25rem] min-w-[8.25rem] sm:w-40 sm:min-w-[10rem] border-l border-stone-200 bg-stone-100 p-2.5 text-center text-sm sm:text-base font-bold shadow-[inset_-6px_0_8px_-6px_rgba(0,0,0,0.06)] sm:p-4 sm:text-lg">
                      التوقيت
                    </th>
                    {ALL_GRADES.map((grade) => (
                      <th
                        key={grade}
                        data-export-grade={grade}
                        className="p-2.5 sm:p-4 font-bold text-sm sm:text-base border-l border-stone-200 text-center min-w-[5.5rem] sm:min-w-[5.75rem] md:min-w-[90px]"
                      >
                        {grade}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map((period, idx) => {
                    const rowBg = idx % 2 === 0 ? 'bg-white' : 'bg-stone-50/80';
                    const timeBg = idx % 2 === 0 ? 'bg-white' : 'bg-stone-50/80';
                    const timeSlot = times[period] ?? { start: '', end: '' };
                    return (
                    <tr
                      key={period}
                      role="row"
                      data-export-period={period}
                      className={`border-b border-stone-200/80 hover:bg-stone-50/90 transition-colors ${rowBg}`}
                    >
                      <td className="sticky right-0 z-20 w-[5.75rem] min-w-[5.75rem] sm:w-24 p-2.5 sm:p-4 font-bold text-sm sm:text-base text-stone-800 border-l border-stone-200/80 text-center bg-stone-100 shadow-[inset_-6px_0_8px_-6px_rgba(0,0,0,0.06)]">
                        {period}
                      </td>
                      <td
                        className={`sticky right-[5.75rem] sm:right-24 z-10 w-[8.25rem] min-w-[8.25rem] sm:w-40 p-2 sm:p-2 border-l border-stone-200/80 text-center align-middle shadow-[inset_-6px_0_8px_-6px_rgba(0,0,0,0.06)] ${timeBg}`}
                      >
                        <div className="flex flex-col items-stretch justify-center gap-1.5 sm:gap-1.5">
                          <div className="flex items-center gap-1 justify-center print:hidden">
                            <Clock className="h-4 w-4 sm:h-3.5 sm:w-3.5 text-stone-400 shrink-0" aria-hidden />
                            <span className="text-xs sm:text-xs font-bold text-stone-500 whitespace-nowrap">من</span>
                            <input
                              type="time"
                              step={60}
                              lang="en-GB"
                              value={timeSlot.start}
                              onChange={(e) => handlePeriodTimeChange(period, 'start', e.target.value)}
                              className="time-input-24h min-w-0 w-[5rem] sm:w-[5.25rem] min-h-[40px] select-text rounded-md border-0 bg-transparent py-1 text-center text-sm sm:text-sm font-bold text-stone-800 outline-none focus:ring-2 focus:ring-teal-400 [color-scheme:light]"
                              aria-label={`بداية الحصة ${period}`}
                            />
                          </div>
                          <div className="flex items-center gap-1 justify-center print:hidden">
                            <span className="w-4 sm:w-3.5 shrink-0" aria-hidden />
                            <span className="text-xs sm:text-xs font-bold text-stone-500 whitespace-nowrap">إلى</span>
                            <input
                              type="time"
                              step={60}
                              lang="en-GB"
                              value={timeSlot.end}
                              onChange={(e) => handlePeriodTimeChange(period, 'end', e.target.value)}
                              className="time-input-24h min-w-0 w-[5rem] sm:w-[5.25rem] min-h-[40px] select-text rounded-md border-0 bg-transparent py-1 text-center text-sm sm:text-sm font-bold text-stone-800 outline-none focus:ring-2 focus:ring-teal-400 [color-scheme:light]"
                              aria-label={`نهاية الحصة ${period}`}
                            />
                          </div>
                          <div className="hidden print:block text-center text-xs font-bold text-stone-800 leading-snug">
                            {timeSlot.start || '—'} — {timeSlot.end || '—'}
                          </div>
                        </div>
                      </td>
                      {ALL_GRADES.map((grade) => {
                        const cellValue = schedule[selectedDay]?.[period]?.[grade] || '';
                        const subjectObj = subjects.find(s => s.id === cellValue);
                        const teacherLabel = subjectObj ? teacherNameById(subjectObj.teacherId) : '';
                        const displayValue = subjectObj
                          ? teacherLabel
                            ? `${subjectObj.name} (${teacherLabel})`
                            : subjectObj.name
                          : cellValue;
                        const isGridFocused = gridFocus.period === period && gridFocus.grade === grade;
                        const hasTeacherCollision = teacherCollisionKeys.has(scheduleCellStorageKey(period, grade));
                        const inRangeSelection = isCellInSelectionRange(period, grade, rangeSelection);

                        return (
                          <td
                            key={grade}
                            data-export-grade={grade}
                            ref={(el) => {
                              const k = scheduleCellStorageKey(period, grade);
                              if (el) scheduleCellRefs.current.set(k, el);
                              else scheduleCellRefs.current.delete(k);
                            }}
                            role="gridcell"
                            tabIndex={isGridFocused ? 0 : -1}
                            aria-selected={inRangeSelection ? true : undefined}
                            aria-label={`${period}، ${grade}${displayValue ? `، ${displayValue}` : ''}${hasTeacherCollision ? '، تعارض: نفس المعلم في صفين أو أكثر في هذه الحصة' : ''}، انقر أو اكتب حرفاً لاختيار المادة`}
                            onFocus={() => setGridFocus({ period, grade })}
                            onKeyDown={(e) => handleScheduleCellKeyDown(e, period, grade)}
                            onPointerDown={(e) => {
                              if (e.button !== 0 || editingCell) return;
                              scheduleMultiCellDragRef.current = false;
                              rangePointerDownRef.current = true;
                              rangeDragAnchorRef.current = { period, grade };
                            }}
                            onPointerEnter={(e) => {
                              if (!rangePointerDownRef.current || editingCell) return;
                              if (e.buttons !== 1) return;
                              const a = rangeDragAnchorRef.current;
                              if (!a) return;
                              if (a.period === period && a.grade === grade) return;
                              scheduleMultiCellDragRef.current = true;
                              rangeShiftAnchorRef.current = a;
                              setRangeSelection({ anchor: a, extent: { period, grade } });
                            }}
                            onClick={(e) => {
                              if (e.shiftKey) {
                                setGridFocus({ period, grade });
                                setRangeSelection({
                                  anchor: rangeShiftAnchorRef.current,
                                  extent: { period, grade },
                                });
                                requestAnimationFrame(() => {
                                  requestAnimationFrame(() => {
                                    scheduleCellRefs.current
                                      .get(scheduleCellStorageKey(period, grade))
                                      ?.focus({ preventScroll: true });
                                  });
                                });
                                return;
                              }
                              if (scheduleMultiCellDragRef.current) {
                                scheduleMultiCellDragRef.current = false;
                                return;
                              }
                              rangeShiftAnchorRef.current = { period, grade };
                              setRangeSelection(null);
                              focusScheduleCell(period, grade);
                              openCellEditor(selectedDay, period, grade);
                            }}
                            className={`p-2 sm:p-3 border-l border-stone-200/80 text-center cursor-pointer transition-colors group relative touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:bg-stone-100/80 ${
                              inRangeSelection
                                ? hasTeacherCollision
                                  ? 'bg-red-100/55 ring-1 ring-inset ring-red-400/85 hover:bg-red-50/90 focus-visible:ring-red-500'
                                  : 'bg-teal-100/70 ring-1 ring-inset ring-teal-400/90 hover:bg-teal-100/80 focus-visible:ring-teal-500'
                                : hasTeacherCollision
                                  ? 'hover:bg-red-50/90 focus-visible:ring-red-500'
                                  : 'hover:bg-teal-50 focus-visible:ring-teal-500'
                            }`}
                          >
                            <div
                              className={`min-h-[3.5rem] sm:min-h-[3.5rem] flex items-center justify-center rounded-lg sm:rounded-xl p-2 sm:p-2.5 transition-all text-sm sm:text-base leading-snug ${
                                displayValue
                                  ? hasTeacherCollision
                                    ? 'bg-red-100/95 text-stone-900 font-bold border border-red-400 shadow-sm'
                                    : 'bg-teal-100/90 text-stone-900 font-bold border border-teal-300 shadow-sm'
                                  : 'text-stone-400 border border-transparent group-hover:border-teal-300 border-dashed'
                              }`}
                            >
                              {displayValue || (
                                <span className="print:hidden text-xs sm:text-sm text-stone-400">انقر أو اكتب للإضافة</span>
                              )}
                              {displayValue ? null : <span className="hidden print:inline">—</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-4 sm:mt-6 pt-4 sm:pt-5 border-t border-stone-200/90 text-center text-[11px] sm:text-sm text-stone-500 leading-relaxed max-w-2xl mx-auto px-2">
                {NAQSH_TECH_ATTRIBUTION_AR}
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="print:hidden border-t border-stone-200/90 bg-stone-100/80 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 text-center">
          <p className="text-sm sm:text-base text-stone-600 leading-relaxed">{NAQSH_TECH_ATTRIBUTION_AR}</p>
        </div>
      </footer>

      {/* Cell Editor Modal */}
      {editingCell && (
        <div className="fixed inset-0 bg-stone-950/55 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-4 print:hidden">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="cell-picker-title"
            className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[min(92dvh,100svh)] sm:max-h-[90vh] transform transition-all outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditingCell(null);
              }
            }}
          >
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-stone-800 to-teal-900 text-white p-5 sm:p-6 flex flex-row gap-3 justify-between items-start">
              <div className="min-w-0 flex-1 pr-2">
                <h3 id="cell-picker-title" className="text-xl sm:text-2xl font-bold leading-snug">
                  اختيار المادة
                </h3>
                <div
                  className="mt-3 flex flex-wrap items-center gap-2 text-xs sm:text-sm"
                  aria-label={`${editingCell.day}، الحصة ${editingCell.period}، الصف ${editingCell.grade}`}
                >
                  <span className="rounded-lg bg-white/10 px-2.5 py-1.5 font-semibold text-white/95 ring-1 ring-white/15">
                    {editingCell.day}
                  </span>
                  <span className="rounded-lg bg-white/10 px-2.5 py-1.5 text-white/90 ring-1 ring-white/15">
                    الحصة {editingCell.period}
                  </span>
                  <span className="rounded-lg bg-white/10 px-2.5 py-1.5 text-white/90 ring-1 ring-white/15">
                    الصف {editingCell.grade}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingCell(null)}
                className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center text-stone-200 hover:text-white hover:bg-white/20 rounded-full transition-colors shrink-0 touch-manipulation"
                aria-label="إغلاق"
              >
                <X className="h-8 w-8" aria-hidden />
              </button>
            </div>

            {/* Modal Body */}
            <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50/90 p-5 sm:p-6 overscroll-contain">
              <div className="space-y-4">
                {subjects.length === 0 ? (
                  <div className="flex items-start gap-3 rounded-2xl border border-teal-100 bg-teal-50/80 p-4 text-sm text-teal-950">
                    <BookOpen className="h-6 w-6 shrink-0 text-teal-700 mt-0.5" />
                    <p className="leading-relaxed">
                      لا توجد مواد في القائمة بعد. اكتب اسم المادة والمعلم هنا أو في الحقول أدناه، ثم أضفها مباشرة
                      إلى الجدول — أو استخدم قسم «إدارة المواد والمعلمين» لاحقاً للتعديل الجماعي.
                    </p>
                  </div>
                ) : null}
                <div>
                  <label htmlFor="cell-subject-search" className="block text-base font-bold text-stone-800 mb-2">
                    بحث سريع (لوحة المفاتيح)
                  </label>
                  <input
                    id="cell-subject-search"
                    ref={cellSubjectSearchRef}
                    type="text"
                    value={cellSubjectFilter}
                    onChange={(e) => {
                      setCellSubjectFilter(e.target.value);
                      setCellQuickAddError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (filteredCellSubjects.length > 0) {
                          const picked = filteredCellSubjects[cellSubjectHighlight];
                          if (picked) handleSelectSubject(picked.id);
                        } else if (showCellQuickAdd) {
                          handleQuickAddSubjectAndAssign();
                        }
                        return;
                      }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setCellSubjectHighlight((h) =>
                          filteredCellSubjects.length === 0
                            ? 0
                            : Math.min(h + 1, filteredCellSubjects.length - 1)
                        );
                        return;
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setCellSubjectHighlight((h) => Math.max(h - 1, 0));
                        return;
                      }
                      if (e.key === 'Home') {
                        e.preventDefault();
                        setCellSubjectHighlight(0);
                        return;
                      }
                      if (e.key === 'End') {
                        e.preventDefault();
                        if (filteredCellSubjects.length > 0) {
                          setCellSubjectHighlight(filteredCellSubjects.length - 1);
                        }
                      }
                    }}
                    placeholder="مادة، أو مادة ثم معلم (مثال: عربي رحمة)"
                    className="w-full min-h-[52px] rounded-xl border border-stone-200 bg-white px-4 py-3 text-base text-stone-900 shadow-sm outline-none transition-all focus:border-teal-500 focus:ring-2 focus:ring-teal-500"
                    autoComplete="off"
                    aria-describedby="cell-subject-kbd-hint"
                  />
                  <p id="cell-subject-kbd-hint" className="mt-2 text-sm text-stone-600 leading-relaxed">
                    كلمة واحدة: تبحث في اسم المادة أو المعلم. كلمتان أو أكثر: الأولى للمادة والباقي للمعلم
                    (مثال: عربي رحمة). عند عدم وجود نتائج يمكنك إضافة مادة ومعلم جديدين من الصندوق التالي. الأسهم
                    ↑↓ و Enter و Home / End و Esc كما سبق.
                  </p>
                </div>
                {filteredCellSubjects.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                    {filteredCellSubjects.map((subject, idx) => {
                      const isSelected =
                        schedule[editingCell.day]?.[editingCell.period]?.[editingCell.grade] === subject.id;
                      const isHighlighted = idx === cellSubjectHighlight;
                      const modalTeacher = teacherNameById(subject.teacherId);
                      return (
                        <button
                          key={subject.id}
                          type="button"
                          onClick={() => handleSelectSubject(subject.id)}
                          onMouseEnter={() => setCellSubjectHighlight(idx)}
                            className={`flex min-h-[96px] flex-col items-center justify-center rounded-2xl border-2 p-4 text-center transition-all touch-manipulation sm:min-h-[100px] sm:p-4 ${
                            isHighlighted
                              ? 'border-teal-600 bg-teal-50 ring-2 ring-teal-400/60 ring-offset-2 ring-offset-stone-50'
                              : isSelected
                                ? 'border-teal-600 bg-teal-50 text-stone-900 shadow-md sm:scale-[1.02]'
                                : 'border-stone-200/80 bg-white text-stone-700 hover:border-teal-400 hover:bg-teal-50/40 hover:shadow-sm'
                          }`}
                        >
                          <span className="font-bold text-lg sm:text-lg leading-tight">{subject.name}</span>
                          {modalTeacher ? (
                            <span className="text-base mt-1 opacity-85">{modalTeacher}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {showCellQuickAdd ? (
                  <div className="rounded-2xl border border-teal-200/90 bg-white p-4 sm:p-5 shadow-sm ring-1 ring-teal-100/80 space-y-4">
                    <div>
                      <h4 className="text-base font-extrabold text-stone-900">إضافة مادة (ومعلم إن لزم)</h4>
                      <p className="mt-1 text-sm text-stone-600 leading-relaxed">
                        يُفسَّر البحث أعلاه كما يلي: أول كلمة اسم المادة، والباقي اسم المعلم. عدّل الحقلين إذا احتجت
                        اسم مادة من عدة كلمات.
                      </p>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label htmlFor="cell-quick-subject" className="block text-base font-bold text-stone-800 mb-2">
                          اسم المادة
                        </label>
                        <input
                          id="cell-quick-subject"
                          type="text"
                          value={cellQuickSubject}
                          onChange={(e) => {
                            setCellQuickSubject(e.target.value);
                            setCellQuickAddDirty(true);
                            setCellQuickAddError('');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleQuickAddSubjectAndAssign();
                            }
                          }}
                          className="w-full min-h-[52px] rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 text-base text-stone-900 shadow-sm outline-none transition-all focus:border-teal-500 focus:ring-2 focus:ring-teal-500"
                          placeholder="مثال: رياضيات"
                          autoComplete="off"
                        />
                      </div>
                      <div>
                        <label htmlFor="cell-quick-teacher" className="block text-base font-bold text-stone-800 mb-2">
                          المعلم (اختياري)
                        </label>
                        <input
                          id="cell-quick-teacher"
                          type="text"
                          value={cellQuickTeacher}
                          onChange={(e) => {
                            setCellQuickTeacher(e.target.value);
                            setCellQuickAddDirty(true);
                            setCellQuickAddError('');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleQuickAddSubjectAndAssign();
                            }
                          }}
                          className="w-full min-h-[52px] rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 text-base text-stone-900 shadow-sm outline-none transition-all focus:border-teal-500 focus:ring-2 focus:ring-teal-500"
                          placeholder="يُنشأ معلم جديد إذا لم يكن اسمه مسجّلاً"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    {cellQuickAddError ? (
                      <p className="text-sm font-medium text-red-600" role="alert">
                        {cellQuickAddError}
                      </p>
                    ) : null}
                    <button
                      type="button"
                      onClick={handleQuickAddSubjectAndAssign}
                      className="w-full sm:w-auto inline-flex min-h-[52px] items-center justify-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-base font-bold text-white shadow-md shadow-teal-900/20 transition-colors hover:bg-teal-700 touch-manipulation"
                    >
                      <Plus className="h-5 w-5 shrink-0" />
                      <span>إضافة مادة ووضعها في الجدول</span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="bg-white p-5 sm:p-6 border-t border-stone-200/80 flex flex-col-reverse sm:flex-row sm:justify-between gap-3 sm:gap-4 items-stretch sm:items-center pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-6">
              <button
                type="button"
                onClick={handleClearCell}
                className="flex items-center justify-center gap-2 px-5 sm:px-6 py-3 min-h-[52px] text-base bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 rounded-xl font-bold transition-colors touch-manipulation"
              >
                <Trash2 className="h-5 w-5 shrink-0" aria-hidden />
                <span>تفريغ الحصة</span>
              </button>

              <button
                type="button"
                onClick={() => setEditingCell(null)}
                className="min-h-[52px] rounded-xl bg-stone-100 px-6 py-3 text-base font-bold text-stone-700 transition-colors hover:bg-stone-200 touch-manipulation sm:px-8"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save to history modal */}
      {saveModalOpen && (
        <div className="fixed inset-0 bg-stone-950/55 backdrop-blur-sm flex items-end sm:items-center justify-center z-[90] p-0 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4 print:hidden">
          <div className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl w-full max-w-md max-h-[90dvh] overflow-hidden flex flex-col">
            <div className="bg-gradient-to-r from-stone-800 to-teal-900 text-white p-4 sm:p-6 flex flex-row gap-3 justify-between items-start shrink-0">
              <div className="min-w-0">
                <h3 className="text-lg sm:text-xl font-bold leading-snug">حفظ الجدول في السجل</h3>
                <p className="text-stone-200 text-xs sm:text-sm mt-1 leading-relaxed">
                  يُحفظ اسم المدرسة، المعلمون، المواد، التوقيتات، تاريخ الجدول، وجميع خلايا الجدول.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSaveModalOpen(false)}
                className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center text-stone-200 hover:text-white hover:bg-white/20 rounded-full transition-colors shrink-0 touch-manipulation"
                aria-label="إغلاق"
              >
                <X className="h-7 w-7" aria-hidden />
              </button>
            </div>
            <div className="p-5 sm:p-6 space-y-5 overflow-y-auto min-h-0">
              <div>
                <label className="block text-base font-bold text-stone-900 mb-2">اسم الجدول</label>
                <input
                  type="text"
                  value={saveTableName}
                  onChange={(e) => setSaveTableName(e.target.value)}
                  className="w-full min-h-[52px] px-4 py-3 text-base border border-stone-200 rounded-xl focus:ring-2 focus:ring-teal-500 outline-none text-stone-900"
                  placeholder="مثال: جدول الأسبوع الأول"
                  autoFocus
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-3 sm:justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setSaveModalOpen(false)}
                  className="min-h-[52px] rounded-xl bg-stone-100 px-5 py-3 text-base font-bold text-stone-800 hover:bg-stone-200 touch-manipulation"
                >
                  إلغاء
                </button>
                {activeSavedTableId ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleSaveToHistory('update')}
                      className="min-h-[52px] px-5 py-3 rounded-xl bg-teal-600 text-white text-base font-bold hover:bg-teal-700 shadow-sm touch-manipulation"
                    >
                      تحديث المحفوظ
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSaveToHistory('new')}
                      className="min-h-[52px] px-5 py-3 rounded-xl border border-stone-200 text-stone-800 text-base font-bold hover:bg-stone-50 touch-manipulation"
                    >
                      حفظ كنسخة جديدة
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSaveToHistory('new')}
                    className="min-h-[52px] px-5 py-3 rounded-xl bg-teal-600 text-white text-base font-bold hover:bg-teal-700 shadow-sm touch-manipulation"
                  >
                    حفظ في السجل
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* History list modal */}
      {historyOpen && (
        <div className="fixed inset-0 bg-stone-950/55 backdrop-blur-sm flex items-end sm:items-center justify-center z-[90] p-0 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4 print:hidden">
          <div className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl w-full max-w-lg max-h-[88dvh] sm:max-h-[85vh] flex flex-col overflow-hidden">
            <div className="bg-gradient-to-r from-stone-800 to-teal-900 text-white p-4 sm:p-6 flex justify-between items-center gap-3 shrink-0">
              <div className="flex items-center gap-3">
                <History className="h-7 w-7 text-stone-200" />
                <div className="min-w-0">
                  <h3 className="text-lg sm:text-xl font-bold leading-snug">الجداول المحفوظة</h3>
                  <p className="text-stone-200 text-sm mt-0.5">{savedTables.length} جدول</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center text-stone-200 hover:text-white hover:bg-white/20 rounded-full transition-colors shrink-0 touch-manipulation"
                aria-label="إغلاق"
              >
                <X className="h-7 w-7" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50/90 p-4 sm:p-5">
              {savedTables.length === 0 ? (
                <div className="text-center py-16 text-stone-500">
                  <FolderOpen className="h-14 w-14 mx-auto text-stone-300 mb-3" />
                  <p className="font-bold text-stone-900">لا توجد جداول محفوظة بعد</p>
                  <p className="text-sm mt-2">استخدم «حفظ في السجل» لحفظ الجدول الحالي.</p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {savedTables.map((entry) => (
                    <li
                      key={entry.id}
                      className={`flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-2xl border bg-white shadow-sm ${
                        activeSavedTableId === entry.id ? 'border-teal-400 ring-1 ring-teal-200/80' : 'border-stone-200/80'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-stone-900 truncate">{entry.name}</div>
                        <div className="text-xs text-stone-500 mt-1">
                          آخر تحديث:{' '}
                          {new Date(entry.updatedAt).toLocaleString('ar', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-3 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleLoadSaved(entry)}
                          className="min-h-[48px] px-5 py-2.5 rounded-xl bg-teal-600 text-white text-base font-bold hover:bg-teal-700 touch-manipulation"
                        >
                          فتح للتحرير
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSaved(entry)}
                          className="min-h-[48px] px-5 py-2.5 rounded-xl border border-red-200 text-red-600 text-base font-bold hover:bg-red-50 touch-manipulation"
                        >
                          حذف
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog Modal */}
      {confirmState.isOpen && (
        <div className="fixed inset-0 bg-stone-950/55 backdrop-blur-sm flex items-end sm:items-center justify-center z-[100] p-0 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4">
          <div className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 sm:p-8 max-w-md w-full transform transition-all max-h-[90dvh] overflow-y-auto">
            <h3 className="text-xl sm:text-2xl font-bold mb-2 sm:mb-3 text-stone-900 leading-snug">
              {confirmState.title}
            </h3>
            <p className="text-stone-700 mb-6 sm:mb-8 leading-relaxed text-base sm:text-lg">
              {confirmState.message}
            </p>
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 sm:gap-0 sm:space-x-3 sm:space-x-reverse">
              <button
                type="button"
                onClick={closeConfirm}
                className="min-h-[48px] w-full rounded-xl bg-stone-100 px-6 py-3 font-bold text-stone-700 transition-colors hover:bg-stone-200 touch-manipulation sm:w-auto"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={confirmState.onConfirm}
                className="w-full sm:w-auto px-6 py-3 min-h-[48px] bg-red-600 text-white hover:bg-red-700 rounded-xl font-bold transition-colors shadow-sm shadow-red-200 touch-manipulation"
              >
                تأكيد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

