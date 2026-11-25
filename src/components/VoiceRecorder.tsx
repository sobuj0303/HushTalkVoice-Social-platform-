import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2, Check } from 'lucide-react';
import { uploadMediaFile } from '../lib/api';

interface VoiceRecorderProps {
  onAudioReady: (url: string) => void;
  onCancel?: () => void;
  compact?: boolean;
}

export const VoiceRecorder: React.FC<VoiceRecorderProps> = ({
  onAudioReady,
  onCancel,
  compact = false,
}) => {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const startRecording = async () => {
    setError('');
    setRecordedBlob(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl('');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        setRecordedBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setSeconds(0);
      timerRef.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      setError('Microphone access denied or unavailable. You can still upload an audio file.');
    }
  };

  const stopRecording = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  const confirmUpload = async () => {
    if (!recordedBlob) return;
    setUploading(true);
    setError('');
    try {
      const ext = recordedBlob.type.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([recordedBlob], `voice-note-${Date.now()}.${ext}`, {
        type: recordedBlob.type || 'audio/webm',
      });
      const res = await uploadMediaFile(file, 'audio');
      onAudioReady(res.url);
    } catch (err: any) {
      setError(err?.message || 'Failed to upload voice note.');
    } finally {
      setUploading(false);
    }
  };

  const formatDuration = (total: number) => {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div className="htv-elevated rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          {!recording && !recordedBlob && (
            <button
              type="button"
              onClick={startRecording}
              className="htv-gradient-btn px-3.5 py-2 rounded-lg text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <Mic className="w-4 h-4" />
              {compact ? 'Record Voice' : 'Start Voice Recording'}
            </button>
          )}
          {recording && (
            <button
              type="button"
              onClick={stopRecording}
              className="px-3.5 py-2 rounded-lg text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              Stop ({formatDuration(seconds)})
            </button>
          )}
          {recording && (
            <span className="text-xs text-rose-400 font-mono-tabular">
              Recording live audio...
            </span>
          )}
        </div>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-[var(--htv-text-muted)] hover:text-[var(--htv-text)] px-2 py-1 rounded-md cursor-pointer"
          >
            Close
          </button>
        )}
      </div>

      {previewUrl && recordedBlob && (
        <div className="flex items-center gap-2 flex-wrap">
          <audio src={previewUrl} controls className="h-9 flex-1 min-w-[180px]" />
          <button
            type="button"
            disabled={uploading}
            onClick={confirmUpload}
            className="htv-gradient-btn px-3 py-2 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer disabled:opacity-50"
          >
            <Check className="w-3.5 h-3.5" />
            {uploading ? 'Attaching...' : 'Attach Voice'}
          </button>
          <button
            type="button"
            onClick={() => {
              setRecordedBlob(null);
              setPreviewUrl('');
            }}
            aria-label="Discard recording"
            className="p-2 rounded-lg border border-[var(--htv-border-subtle)] text-[var(--htv-text-muted)] hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}

      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
    </div>
  );
};
