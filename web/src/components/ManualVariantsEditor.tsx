import { AnimatePresence, motion } from 'motion/react';
import { Plus, X } from 'lucide-react';
import type { ManualVariant } from '../api';
import { useMotionUITransition, useMotionUITheme } from '@/components/motion-ui/ui-theme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  value: ManualVariant[];
  onChange: (v: ManualVariant[]) => void;
}

export function ManualVariantsEditor({ value, onChange }: Props) {
  const ui = useMotionUITransition('ui');
  const { motionMode } = useMotionUITheme();
  const still = motionMode === 'off';

  function update(i: number, patch: Partial<ManualVariant>) {
    onChange(value.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }
  function add() {
    onChange([...value, { label: `Variante ${value.length + 1}`, systemPrompt: '' }]);
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }

  return (
    <div className="w-full">
      <div className="mb-1 text-sm font-medium">Variantes manuais</div>
      <p className="mb-3 text-[13px] text-muted-foreground">
        2 ou mais system prompts — rodam como estão, sem reescrita por LLM.
      </p>

      <div className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {value.map((v, i) => (
            <motion.div
              key={i}
              layout={!still}
              initial={still ? false : { opacity: 0, transform: 'translateY(-4px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              exit={still ? { opacity: 0 } : { opacity: 0, transform: 'translateY(-4px)' }}
              transition={ui}
              className="rounded-lg border border-border p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <Input
                  type="text"
                  className="h-8 flex-1"
                  aria-label={`Nome da variante ${i + 1}`}
                  value={v.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder={`Variante ${i + 1}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remover variante ${i + 1}`}
                  onClick={() => remove(i)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <Textarea
                rows={4}
                aria-label={`System prompt da variante ${i + 1}`}
                value={v.systemPrompt}
                onChange={(e) => update(i, { systemPrompt: e.target.value })}
                placeholder="System prompt desta variante…"
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={add}>
        <Plus aria-hidden="true" />
        Adicionar variante
      </Button>
    </div>
  );
}
