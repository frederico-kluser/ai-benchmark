import { useEffect, useState } from 'react';
import { Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ValidateKeyResponse } from '../api';
import { getStoredKey, setStoredKey, validateKey } from '../api';
import { MultiStateButton } from '@/components/motion-ui/multi-state-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner, PageHeader, Screen } from './primitives';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'validating' | 'valid' | 'invalid';

function usd(v: number): string {
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

function describeKey(res: ValidateKeyResponse): string {
  const parts: string[] = ['Key válida'];
  if (res.label) parts.push(`(${res.label})`);
  if (typeof res.usageUsd === 'number') {
    const limit =
      res.limitUsd === null || res.limitUsd === undefined ? 'sem limite' : `limite ${usd(res.limitUsd)}`;
    parts.push(`— uso ${usd(res.usageUsd)} / ${limit}`);
  }
  if (res.isFreeTier) parts.push('· tier gratuito');
  return parts.join(' ') + '.';
}

// Rótulo e glifo do botão por estado — o MultiStateButton morfa a largura entre eles.
const BUTTON_LABEL: Record<Status, string> = {
  idle: 'Validar e salvar',
  validating: 'Validando…',
  valid: 'Key salva',
  invalid: 'Tentar de novo',
};

export function KeySetup({ onSaved }: { onSaved?: () => void }) {
  const [key, setKey] = useState(getStoredKey());
  const [status, setStatus] = useState<Status>(getStoredKey() ? 'valid' : 'idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setKey(getStoredKey());
  }, []);

  async function handleValidate(rawKey?: string) {
    const target = (rawKey ?? key).trim();
    if (!target) {
      setStatus('invalid');
      setMessage('Cole sua key do OpenRouter.');
      return;
    }
    setStatus('validating');
    setMessage(null);
    try {
      const res = await validateKey(target);
      if (res.ok) {
        setStoredKey(target);
        setStatus('valid');
        setMessage(describeKey(res));
        onSaved?.();
      } else {
        setStoredKey('');
        setStatus('invalid');
        setMessage(res.error ?? 'Key inválida.');
      }
    } catch (err) {
      setStatus('invalid');
      setMessage((err as Error).message);
    }
  }

  function handleClear() {
    setStoredKey('');
    setKey('');
    setStatus('idle');
    setMessage(null);
  }

  const icon =
    status === 'validating' ? (
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
    ) : status === 'valid' ? (
      <Check className="size-4" aria-hidden="true" />
    ) : status === 'invalid' ? (
      <TriangleAlert className="size-4" aria-hidden="true" />
    ) : undefined;

  return (
    <div className="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
      <h2 className="font-heading text-base font-medium">OpenRouter API Key</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        Cole sua key do OpenRouter. Ela fica salva só no <code className="font-mono text-[12.5px]">localStorage</code>{' '}
        deste navegador e vai direto do navegador para o OpenRouter — nenhum outro servidor a recebe.{' '}
        <a
          className="text-primary underline-offset-4 hover:underline"
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
        >
          openrouter.ai/keys ↗
        </a>
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[16rem] flex-1 font-mono text-[13px]"
          type="password"
          autoComplete="off"
          aria-label="OpenRouter API key"
          placeholder="sk-or-v1-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim();
            if (pasted) {
              setKey(pasted);
              setTimeout(() => handleValidate(pasted), 0);
              e.preventDefault();
            }
          }}
        />
        <MultiStateButton
          state={status}
          icon={icon}
          feedback={status === 'invalid' ? 'shake' : status === 'valid' ? 'pop' : 'none'}
          announce={message ?? undefined}
          disabled={status === 'validating'}
          onClick={() => void handleValidate()}
          pillClassName="rounded-lg px-3.5 py-2 text-sm font-medium"
          surfaceClassName={
            status === 'invalid' ? 'bg-destructive/10 text-destructive' : 'bg-primary text-primary-foreground'
          }
        >
          {BUTTON_LABEL[status]}
        </MultiStateButton>
        {status === 'valid' && (
          <Button type="button" variant="ghost" onClick={handleClear}>
            Remover
          </Button>
        )}
      </div>

      {message && (
        <Banner tone={status === 'invalid' ? 'error' : 'neutral'} className="mt-3">
          {message}
        </Banner>
      )}
    </div>
  );
}

export function KeyGate({ children }: { children: React.ReactNode }) {
  const [hasKey, setHasKey] = useState(!!getStoredKey());
  if (!hasKey) {
    return (
      <Screen>
        <PageHeader
          title="Conecte sua chave"
          subtitle="Para criar uma run, cole sua chave da OpenRouter. Ela fica salva só no seu navegador."
        />
        <KeySetup onSaved={() => setHasKey(true)} />
      </Screen>
    );
  }
  return <>{children}</>;
}
