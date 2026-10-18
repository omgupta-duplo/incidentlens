import { InjectionToken } from '@angular/core';

/**
 * Provider-agnostic dictation for the reporter's note. NO provider is selected for this service yet, so the default
 * provider is "not configured": it never touches the microphone, never starts browser speech recognition and never
 * uploads audio. A future provider is plugged in by providing DICTATION_PROVIDER (after a privacy/cost decision);
 * whatever it returns is only ever shown as an EDITABLE transcript in the speaker's own language — never auto-submitted.
 */
export interface DictationProvider {
  /** Human-readable provider name, or null when none is configured. */
  readonly name: string | null;
  /** 'not_configured' — nothing can be recorded; 'ready' — a provider may be started by an explicit user action. */
  status(): 'not_configured' | 'ready';
  /** Only called after the user presses Dictate. Resolves with the original-language transcript. */
  transcribe(languageTag: string): Promise<string>;
  /** Required before this UI enables a provider: stop capture and resolve its final transcript. */
  stop?(): void;
}

export const UNCONFIGURED_DICTATION: DictationProvider = {
  name: null,
  status: () => 'not_configured',
  transcribe: () => Promise.reject(new Error('not_configured')),
};

export const DICTATION_PROVIDER = new InjectionToken<DictationProvider>('IncidentLens reporter dictation provider', {
  providedIn: 'root', factory: () => UNCONFIGURED_DICTATION,
});

/** Regional languages offered for the note (BCP-47 tag, native name, English name, writing direction). */
export interface NoteLanguage { tag: string; native: string; english: string; dir: 'ltr' | 'rtl'; }
export const NOTE_LANGUAGES: NoteLanguage[] = [
  { tag: 'en-IN', native: 'English', english: 'English', dir: 'ltr' },
  { tag: 'hi-IN', native: 'हिन्दी', english: 'Hindi', dir: 'ltr' },
  { tag: 'mr-IN', native: 'मराठी', english: 'Marathi', dir: 'ltr' },
  { tag: 'bn-IN', native: 'বাংলা', english: 'Bengali', dir: 'ltr' },
  { tag: 'ta-IN', native: 'தமிழ்', english: 'Tamil', dir: 'ltr' },
  { tag: 'te-IN', native: 'తెలుగు', english: 'Telugu', dir: 'ltr' },
  { tag: 'kn-IN', native: 'ಕನ್ನಡ', english: 'Kannada', dir: 'ltr' },
  { tag: 'ml-IN', native: 'മലയാളം', english: 'Malayalam', dir: 'ltr' },
  { tag: 'gu-IN', native: 'ગુજરાતી', english: 'Gujarati', dir: 'ltr' },
  { tag: 'pa-IN', native: 'ਪੰਜਾਬੀ', english: 'Punjabi', dir: 'ltr' },
  { tag: 'or-IN', native: 'ଓଡ଼ିଆ', english: 'Odia', dir: 'ltr' },
  { tag: 'ur-IN', native: 'اردو', english: 'Urdu', dir: 'rtl' },
  { tag: 'ne-NP', native: 'नेपाली', english: 'Nepali', dir: 'ltr' },
];

/** The note limit the server enforces. Counted like the server (UTF-16 code units); text is NEVER cut to fit. */
export const NOTE_MAX = 280;
export function noteCheck(text: string): { length: number; over: number; ok: boolean } {
  const length = (text ?? '').trim().length;
  return { length, over: Math.max(0, length - NOTE_MAX), ok: length <= NOTE_MAX };
}
