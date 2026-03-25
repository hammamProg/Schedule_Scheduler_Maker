import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Calendar, Clock, BookOpen, Settings, X, Download, Upload, Edit2, Image as ImageIcon, Check } from 'lucide-react';
import { toPng } from 'html-to-image';

type Day = 'الأحد' | 'الإثنين' | 'الثلاثاء' | 'الأربعاء' | 'الخميس';
type Period = 'الأولى' | 'الثانية' | 'الثالثة' | 'الرابعة' | 'الخامسة' | 'السادسة' | 'السابعة';
type Grade = 'الأول' | 'الثاني' | 'الثالث' | 'الرابع' | 'الخامس' | 'السادس' | 'السابع' | 'الثامن' | 'التاسع' | 'العاشر' | '١١' | '١٢';

type Subject = {
  id: string;
  name: string;
  teacher: string;
};

type ConfirmState = {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
};

const ALL_GRADES: Grade[] = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر', '١١', '١٢'];
const DAYS: Day[] = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const PERIODS: Period[] = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة'];

// Custom hook for local storage
function useLocalStorage<T>(key: string, initialValue: T) {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
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
  const [selectedDay, setSelectedDay] = useLocalStorage<Day>('scheduler_selectedDay', 'الأحد');
  const [subjects, setSubjects] = useLocalStorage<Subject[]>('scheduler_subjects_v2', []);
  const [schedule, setSchedule] = useLocalStorage<Record<string, Record<string, Record<string, string>>>>('scheduler_data_v2', {});
  const [times, setTimes] = useLocalStorage<Record<string, string>>('scheduler_times', {});
  const [dates, setDates] = useLocalStorage<Record<string, string>>('scheduler_dates', {});

  const [newSubject, setNewSubject] = useState('');
  const [newTeacher, setNewTeacher] = useState('');
  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null);

  const [editingCell, setEditingCell] = useState<{ day: Day; period: Period; grade: Grade } | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>({ isOpen: false, title: '', message: '', onConfirm: () => {} });

  const tableRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Migration from old string[] subjects to Subject[]
  useEffect(() => {
    const oldSubjects = window.localStorage.getItem('scheduler_subjects');
    if (oldSubjects && subjects.length === 0) {
      try {
        const parsed = JSON.parse(oldSubjects);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
          const migrated = parsed.map((s: string, i: number) => {
            const match = s.match(/(.+?)(?:\s*\((.+)\))?$/);
            return {
              id: Date.now().toString() + i,
              name: match ? match[1].trim() : s,
              teacher: match && match[2] ? match[2].trim() : ''
            };
          });
          setSubjects(migrated);
        }
      } catch (e) {
        console.error('Migration failed', e);
      }
    }
  }, []);

  const confirmAction = (title: string, message: string, onConfirm: () => void) => {
    setConfirmState({ isOpen: true, title, message, onConfirm });
  };

  const closeConfirm = () => setConfirmState(prev => ({ ...prev, isOpen: false }));

  const handleSaveSubject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubject.trim()) return;

    if (editingSubjectId) {
      setSubjects(prev => prev.map(s =>
        s.id === editingSubjectId
          ? { ...s, name: newSubject.trim(), teacher: newTeacher.trim() }
          : s
      ));
      setEditingSubjectId(null);
    } else {
      setSubjects(prev => [...prev, {
        id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
        name: newSubject.trim(),
        teacher: newTeacher.trim()
      }]);
    }
    setNewSubject('');
    setNewTeacher('');
  };

  const handleEditSubject = (subject: Subject) => {
    setEditingSubjectId(subject.id);
    setNewSubject(subject.name);
    setNewTeacher(subject.teacher);
  };

  const handleCancelEdit = () => {
    setEditingSubjectId(null);
    setNewSubject('');
    setNewTeacher('');
  };

  const handleDeleteSubject = (subject: Subject) => {
    confirmAction(
      'حذف مادة',
      `هل أنت متأكد من حذف مادة "${subject.name}"؟ لن يتم حذفها من الجدول المحفوظ مسبقاً.`,
      () => {
        setSubjects(prev => prev.filter(s => s.id !== subject.id));
        closeConfirm();
      }
    );
  };

  const handleExportSubjects = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(subjects));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "subjects_teachers.json");
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
          const valid = imported.filter(i => i.id && i.name);
          if (valid.length > 0) {
            setSubjects(valid);
          }
        }
      } catch (err) {
        console.error("Invalid JSON file");
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleTimeChange = (period: Period, time: string) => {
    setTimes(prev => ({ ...prev, [period]: time }));
  };

  const handleCellClick = (day: Day, period: Period, grade: Grade) => {
    setEditingCell({ day, period, grade });
  };

  const handleSelectSubject = (subjectId: string) => {
    if (!editingCell) return;
    const { day, period, grade } = editingCell;
    
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
    try {
      const dataUrl = await toPng(tableRef.current, {
        backgroundColor: '#ffffff',
        pixelRatio: 2,
      });

      const link = document.createElement('a');
      const dateStr = dates[selectedDay] ? `-${dates[selectedDay]}` : '';
      link.download = `جدول-${selectedDay}${dateStr}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Error generating image', err);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans" dir="rtl">
      {/* Header */}
      <header className="bg-gradient-to-r from-indigo-800 to-blue-700 text-white shadow-lg print:hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 flex justify-between items-center">
          <div className="flex items-center space-x-3 space-x-reverse">
            <Calendar className="h-8 w-8 text-indigo-200" />
            <h1 className="text-2xl font-bold tracking-tight">صانع الجداول المدرسية</h1>
          </div>
          <button 
            onClick={handleDownloadImage}
            className="flex items-center space-x-2 space-x-reverse bg-white/20 hover:bg-white/30 text-white px-5 py-2.5 rounded-xl transition-all backdrop-blur-sm font-medium shadow-sm"
          >
            <ImageIcon className="h-5 w-5" />
            <span>تحميل كصورة</span>
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Settings & Subjects Section */}
        <section className="bg-white rounded-2xl shadow-sm border border-indigo-100 p-6 print:hidden">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
            <div className="flex items-center space-x-3 space-x-reverse">
              <Settings className="h-7 w-7 text-indigo-600" />
              <h2 className="text-2xl font-bold text-indigo-900">إدارة المواد والمعلمين</h2>
            </div>
            <div className="flex items-center space-x-3 space-x-reverse">
              <button
                onClick={handleExportSubjects}
                className="flex items-center space-x-2 space-x-reverse px-4 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-xl font-medium transition-colors"
              >
                <Download className="h-4 w-4" />
                <span>تصدير</span>
              </button>
              <label className="flex items-center space-x-2 space-x-reverse px-4 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-xl font-medium transition-colors cursor-pointer">
                <Upload className="h-4 w-4" />
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
          
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* Add/Edit Subject Form */}
            <div className="lg:col-span-1 bg-indigo-50/50 p-5 rounded-2xl border border-indigo-100">
              <h3 className="text-lg font-bold mb-5 text-indigo-900">
                {editingSubjectId ? 'تعديل المادة' : 'إضافة مادة جديدة'}
              </h3>
              <form onSubmit={handleSaveSubject} className="space-y-4">
                <div>
                  <label className="block text-sm font-bold text-indigo-800 mb-1.5">المادة (مثال: رياضيات)</label>
                  <input
                    type="text"
                    value={newSubject}
                    onChange={(e) => setNewSubject(e.target.value)}
                    className="w-full px-4 py-2.5 border border-indigo-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all shadow-sm"
                    placeholder="اسم المادة"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-indigo-800 mb-1.5">المعلم (اختياري)</label>
                  <input
                    type="text"
                    value={newTeacher}
                    onChange={(e) => setNewTeacher(e.target.value)}
                    className="w-full px-4 py-2.5 border border-indigo-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all shadow-sm"
                    placeholder="اسم المعلم"
                  />
                </div>
                <div className="flex space-x-3 space-x-reverse pt-2">
                  <button
                    type="submit"
                    className="flex-1 flex justify-center items-center space-x-2 space-x-reverse bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl transition-colors font-bold shadow-sm shadow-indigo-200"
                  >
                    {editingSubjectId ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                    <span>{editingSubjectId ? 'حفظ التعديلات' : 'إضافة للقائمة'}</span>
                  </button>
                  {editingSubjectId && (
                    <button
                      type="button"
                      onClick={handleCancelEdit}
                      className="px-4 py-2.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 rounded-xl font-bold transition-colors shadow-sm"
                    >
                      إلغاء
                    </button>
                  )}
                </div>
              </form>
            </div>

            {/* Subjects List */}
            <div className="lg:col-span-2">
              <h3 className="text-lg font-bold mb-5 text-indigo-900 flex items-center space-x-2 space-x-reverse">
                <BookOpen className="h-5 w-5 text-indigo-500" />
                <span>المواد المضافة ({subjects.length})</span>
              </h3>
              {subjects.length === 0 ? (
                <div className="text-center py-12 bg-indigo-50/50 rounded-2xl border-2 border-dashed border-indigo-200 text-indigo-400 font-medium">
                  لم يتم إضافة أي مواد بعد. استخدم النموذج لإضافة المواد.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-h-[300px] overflow-y-auto p-2">
                  {subjects.map((subject) => (
                    <div key={subject.id} className="flex flex-col bg-white p-4 rounded-xl border border-indigo-100 shadow-sm hover:shadow-md transition-shadow">
                      <div className="font-bold text-indigo-900 text-lg">{subject.name}</div>
                      <div className="text-sm text-indigo-500 mb-4">{subject.teacher || 'بدون معلم'}</div>
                      <div className="flex justify-end space-x-2 space-x-reverse mt-auto pt-3 border-t border-indigo-50">
                        <button 
                          onClick={() => handleEditSubject(subject)} 
                          className="text-blue-500 hover:bg-blue-50 p-2 rounded-lg transition-colors"
                          title="تعديل"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button 
                          onClick={() => handleDeleteSubject(subject)} 
                          className="text-red-500 hover:bg-red-50 p-2 rounded-lg transition-colors"
                          title="حذف"
                        >
                          <Trash2 className="h-4 w-4" />
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
        <section className="bg-white rounded-2xl shadow-sm border border-indigo-100 overflow-hidden">
          {/* Controls */}
          <div className="p-6 border-b border-indigo-100 bg-indigo-50/30 print:hidden">
            <div className="flex flex-col sm:flex-row justify-between items-center gap-6">
              
              {/* Day Selector */}
              <div className="flex flex-wrap justify-center gap-2">
                {DAYS.map(day => (
                  <button
                    key={day}
                    onClick={() => setSelectedDay(day)}
                    className={`px-6 py-2.5 rounded-xl font-bold transition-all ${
                      selectedDay === day 
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200 scale-105' 
                        : 'bg-white border border-indigo-100 text-indigo-700 hover:bg-indigo-50'
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </div>

              {/* Date Input */}
              <div className="flex items-center space-x-3 space-x-reverse bg-white p-2 rounded-xl border border-indigo-100 shadow-sm">
                <label className="text-sm font-bold text-indigo-900 whitespace-nowrap px-2">تاريخ اليوم:</label>
                <input
                  type="date"
                  value={dates[selectedDay] || ''}
                  onChange={(e) => setDates(prev => ({ ...prev, [selectedDay]: e.target.value }))}
                  className="border-none bg-indigo-50/50 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-indigo-900 font-medium"
                />
              </div>
            </div>
          </div>

          {/* Table Container for Image Export */}
          <div className="overflow-x-auto bg-white">
            <div ref={tableRef} className="min-w-max p-8 bg-white">
              
              {/* Header for Image/Print */}
              <div className="text-center mb-8">
                <h2 className="text-3xl font-bold text-indigo-900 mb-2">الجدول المدرسي - {selectedDay}</h2>
                {dates[selectedDay] && <h3 className="text-xl font-medium text-indigo-600">{dates[selectedDay]}</h3>}
              </div>

              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-indigo-50 text-indigo-900 border-b-2 border-indigo-200">
                    <th className="p-4 font-bold text-lg border-l border-indigo-200 w-24 text-center">الحصة</th>
                    <th className="p-4 font-bold text-lg border-l border-indigo-200 w-32 text-center">التوقيت</th>
                    {ALL_GRADES.map(grade => (
                      <th key={grade} className="p-4 font-bold text-base border-l border-indigo-200 text-center min-w-[90px]">
                        {grade}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PERIODS.map((period, idx) => (
                    <tr key={period} className={`border-b border-indigo-100 hover:bg-indigo-50/50 transition-colors ${idx % 2 === 0 ? 'bg-white' : 'bg-indigo-50/20'}`}>
                      <td className="p-4 font-bold text-indigo-800 border-l border-indigo-100 text-center bg-indigo-50/40">
                        {period}
                      </td>
                      <td className="p-2 border-l border-indigo-100 text-center align-middle">
                        <div className="flex items-center justify-center">
                          <Clock className="h-4 w-4 text-indigo-400 ml-1 print:hidden" />
                          <input
                            type="text"
                            value={times[period] || ''}
                            onChange={(e) => handleTimeChange(period, e.target.value)}
                            placeholder="—"
                            className="w-full text-center bg-transparent border-none focus:ring-2 focus:ring-indigo-400 rounded px-1 py-2 outline-none font-bold text-indigo-700 placeholder-indigo-300"
                          />
                        </div>
                      </td>
                      {ALL_GRADES.map(grade => {
                        const cellValue = schedule[selectedDay]?.[period]?.[grade] || '';
                        const subjectObj = subjects.find(s => s.id === cellValue);
                        
                        // Fallback to raw string if it's old unmigrated data
                        const displayValue = subjectObj 
                          ? (subjectObj.teacher ? `${subjectObj.name} (${subjectObj.teacher})` : subjectObj.name) 
                          : cellValue;

                        return (
                          <td 
                            key={grade} 
                            onClick={() => handleCellClick(selectedDay, period, grade)}
                            className="p-3 border-l border-indigo-100 text-center cursor-pointer hover:bg-indigo-100 transition-colors group relative"
                          >
                            <div className={`min-h-[3.5rem] flex items-center justify-center rounded-xl p-2 transition-all ${displayValue ? 'bg-indigo-100 text-indigo-900 font-bold border border-indigo-300 shadow-sm' : 'text-indigo-300 border border-transparent group-hover:border-indigo-300 border-dashed'}`}>
                              {displayValue || <span className="print:hidden text-sm">اضغط للإضافة</span>}
                              {displayValue ? null : <span className="hidden print:inline">—</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      {/* Cell Editor Modal */}
      {editingCell && (
        <div className="fixed inset-0 bg-indigo-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 print:hidden">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-indigo-700 to-blue-600 text-white p-6 flex justify-between items-center">
              <div>
                <h3 className="text-2xl font-bold">اختيار المادة</h3>
                <p className="text-indigo-100 mt-1.5 font-medium">
                  {editingCell.day} - الحصة {editingCell.period} - الصف {editingCell.grade}
                </p>
              </div>
              <button 
                onClick={() => setEditingCell(null)}
                className="text-indigo-100 hover:text-white hover:bg-white/20 p-2 rounded-full transition-colors"
              >
                <X className="h-7 w-7" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1 bg-gray-50">
              {subjects.length === 0 ? (
                <div className="text-center py-16 text-indigo-400">
                  <BookOpen className="h-16 w-16 mx-auto text-indigo-200 mb-4" />
                  <p className="text-xl font-bold text-indigo-900">لم تقم بإضافة أي مواد بعد.</p>
                  <p className="text-base mt-2">يرجى إغلاق هذه النافذة وإضافة المواد من قسم "إدارة المواد والمعلمين".</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {subjects.map((subject) => {
                    const isSelected = schedule[editingCell.day]?.[editingCell.period]?.[editingCell.grade] === subject.id;
                    return (
                      <button
                        key={subject.id}
                        onClick={() => handleSelectSubject(subject.id)}
                        className={`p-4 rounded-2xl border-2 text-center transition-all flex flex-col items-center justify-center min-h-[100px] ${
                          isSelected 
                            ? 'border-indigo-600 bg-indigo-50 text-indigo-900 shadow-md scale-[1.02]' 
                            : 'border-indigo-100 bg-white text-indigo-700 hover:border-indigo-400 hover:bg-indigo-50 hover:shadow-sm'
                        }`}
                      >
                        <span className="font-bold text-lg">{subject.name}</span>
                        {subject.teacher && <span className="text-sm mt-1 opacity-80">{subject.teacher}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="bg-white p-6 border-t border-indigo-100 flex justify-between items-center">
              <button
                onClick={handleClearCell}
                className="flex items-center space-x-2 space-x-reverse px-6 py-3 bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-700 rounded-xl font-bold transition-colors"
              >
                <Trash2 className="h-5 w-5" />
                <span>تفريغ الحصة</span>
              </button>
              
              <button
                onClick={() => setEditingCell(null)}
                className="px-8 py-3 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-xl font-bold transition-colors"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog Modal */}
      {confirmState.isOpen && (
        <div className="fixed inset-0 bg-indigo-900/40 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full transform transition-all">
            <h3 className="text-2xl font-bold mb-3 text-indigo-900">{confirmState.title}</h3>
            <p className="text-indigo-700 mb-8 leading-relaxed text-lg">{confirmState.message}</p>
            <div className="flex justify-end space-x-3 space-x-reverse">
              <button
                onClick={closeConfirm}
                className="px-6 py-3 bg-gray-100 text-gray-700 hover:bg-gray-200 rounded-xl font-bold transition-colors"
              >
                إلغاء
              </button>
              <button
                onClick={confirmState.onConfirm}
                className="px-6 py-3 bg-red-600 text-white hover:bg-red-700 rounded-xl font-bold transition-colors shadow-sm shadow-red-200"
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

