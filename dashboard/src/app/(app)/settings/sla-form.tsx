'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function SlaForm({ ruleId, initialMinutes, canEdit = true }: { ruleId: string; initialMinutes: number; canEdit?: boolean }) {
  const router = useRouter();
  const [minutes, setMinutes] = useState(initialMinutes);
  const [savedMinutes, setSavedMinutes] = useState(initialMinutes);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    const res = await fetch(`/api/policies/${ruleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sla_minutes: minutes }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    setSaving(false);
    if (!res?.ok) {
      setMessage({ kind: 'error', text: data?.message ?? 'The response time could not be saved. Please try again.' });
      return;
    }
    setSavedMinutes(minutes);
    setMessage({ kind: 'ok', text: 'Saved. New leads use this response time.' });
    router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-4">
        <div className="w-48">
          <label htmlFor="sla-minutes" className="text-sm font-medium text-[color:var(--apple-text-secondary)] block mb-1">Respond within (minutes)</label>
          <Input
            id="sla-minutes"
            type="number"
            value={Number.isFinite(minutes) ? minutes : ''}
            onChange={e => setMinutes(e.target.value === '' ? NaN : Number(e.target.value))}
            min={1}
            max={10080}
            step={1}
            disabled={!canEdit}
            aria-invalid={!valid}
          />
        </div>
        {canEdit ? (
          <Button onClick={handleSave} disabled={saving || !valid || minutes === savedMinutes}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        ) : (
          <p className="text-[12px] text-[color:var(--apple-text-tertiary)]">Only admins can change this.</p>
        )}
      </div>
      <div aria-live="polite">
        {!valid && canEdit && <p className="text-[12px] text-[color:var(--apple-red)]">Enter a whole number of minutes, from 1 to 10080 (one week).</p>}
        {message && (
          <p role={message.kind === 'error' ? 'alert' : 'status'} className="text-[13px]"
            style={{ color: message.kind === 'error' ? 'var(--apple-red)' : 'var(--apple-green)' }}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
