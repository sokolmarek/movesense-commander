/**
 * The File System Access bits we use.
 *
 * `showSaveFilePicker` is not in TypeScript's DOM library yet, and only Chromium
 * implements it - the code guards on its presence at runtime, so this declaration
 * only teaches the compiler what the call looks like.
 */
interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}

interface Window {
  showSaveFilePicker?: (
    options?: SaveFilePickerOptions,
  ) => Promise<FileSystemFileHandle>
}
