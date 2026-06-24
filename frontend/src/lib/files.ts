// Read a File as a base64 string (no data: prefix) plus its mime type.
export async function fileToBase64(file: File): Promise<{ image_base64: string; mime_type: string }> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve({
        image_base64: comma >= 0 ? result.slice(comma + 1) : result,
        mime_type: file.type || 'image/jpeg',
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}
