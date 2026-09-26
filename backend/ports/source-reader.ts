export type SourceReader = (url: string, allowPrivate: boolean) => Promise<string>
export const SOURCE_MEDIA_TYPES = new Set(['text/plain', 'text/markdown', 'text/html', 'application/json'])
