import { useCallback, useRef, useState } from 'react';
import type { ImageData } from '../lib/types';
import { fileToBase64 } from '../lib/files';

interface Props {
  pending: ImageData[];
  setPending: (next: ImageData[]) => void;
}

// Drag-and-drop / click-to-pick image zone. Encodes images to base64 in
// memory; sent along with the next chat message.
export function ImageDropZone({ pending, setPending }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const ingest = useCallback(async (files: FileList | File[]) => {
    const accepted: File[] = [];
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) accepted.push(f);
    }
    if (accepted.length === 0) return;
    const encoded = await Promise.all(accepted.map(fileToBase64));
    setPending([...pending, ...encoded]);
  }, [pending, setPending]);

  return (
    <div
      className={'drop-zone' + (dragOver ? ' dragover' : '')}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) await ingest(e.dataTransfer.files);
      }}
      onClick={() => fileInput.current?.click()}
      title="Drop images here, or click to select"
    >
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          if (e.target.files?.length) await ingest(e.target.files);
          e.target.value = '';
        }}
      />
      {pending.length === 0
        ? 'Drop images or click to attach (whiteboard photo, code screenshot, ...)'
        : `${pending.length} image${pending.length === 1 ? '' : 's'} attached — click to add more`}
      {pending.length > 0 && (
        <div className="pending">
          {pending.map((img, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={`data:${img.mime_type};base64,${img.image_base64}`} />
              <button
                className="danger"
                style={{ position: 'absolute', top: -8, right: -8, padding: '0 6px', fontSize: '0.7rem' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setPending(pending.filter((_, j) => j !== i));
                }}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
