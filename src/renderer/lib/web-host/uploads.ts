/** Upload browser Files to the web host so main can copy them like a desktop file drop. */
import { WEB_HOST_MAX_UPLOAD_BYTES, WEB_HOST_UPLOAD_PATH } from '../../../shared/lib/web-host';

export async function uploadFile(file: File): Promise<string> {
  if (file.size > WEB_HOST_MAX_UPLOAD_BYTES) throw new Error(`${file.name} is too large`);
  const response = await fetch(`${WEB_HOST_UPLOAD_PATH}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok)
    throw new Error((await response.text()) || `Upload failed (${response.status})`);
  const body = (await response.json()) as { path?: unknown };
  if (typeof body.path !== 'string') throw new Error('Upload failed');
  return body.path;
}

/** Server paths for every file, in order; folders (size 0, no type) cannot be uploaded. */
export async function uploadFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) paths.push(await uploadFile(file));
  return paths;
}
