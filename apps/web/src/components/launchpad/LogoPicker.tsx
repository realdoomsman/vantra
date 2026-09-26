// The coin's logo on /launch: pick a photo, it is squared and shrunk in the browser (lib/image.ts),
// uploaded to POST /api/images, and previewed. Uploading needs a session, like the launch itself.
import { useRef, useState } from 'react';
import type { ImageUploadResponse } from '@vantra/shared';
import { api } from '../../api/client';
import { squareLogo } from '../../lib/image';

export function LogoPicker({
  logo, signedIn, onLogo, onBusy,
}: {
  logo: ImageUploadResponse | null;
  signedIn: boolean;
  onLogo: (logo: ImageUploadResponse | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    onBusy(true);
    try {
      onLogo(await api.uploadImage(await squareLogo(file)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The upload failed.');
    } finally {
      setUploading(false);
      onBusy(false);
      // The same file can be picked again after a failure or a removal.
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className={`lx-field${error ? ' has-err' : ''}`}>
      <span className="lx-label">
        LOGO<span className="faint"> · optional</span>
      </span>
      <div className="lx-logo">
        {logo ? <img className="lx-logo-img" src={logo.url} alt="Coin logo" /> : <span className="lx-logo-img is-empty" aria-hidden="true" />}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => void pick(e.target.files?.[0])}
        />
        <button type="button" className="btn-ghost" disabled={!signedIn || uploading} onClick={() => input.current?.click()}>
          {uploading ? 'UPLOADING…' : logo ? 'CHANGE' : 'UPLOAD PHOTO'}
        </button>
        {logo && !uploading && (
          <button type="button" className="btn-ghost" onClick={() => onLogo(null)}>
            REMOVE
          </button>
        )}
      </div>
      {error ? (
        <span className="form-err">{error}</span>
      ) : (
        <span className="form-hint">{signedIn ? 'Cropped to a square in your browser.' : 'Sign in to upload a logo.'}</span>
      )}
    </div>
  );
}
