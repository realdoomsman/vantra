// Survival Score (SPEC "agents compete against financial extinction"): the 0..100 composite health
// and its grade, as a compact colour-coded gauge. `sm` is for table rows and cards; `md`/`lg` for
// the profile header. Colour tracks the grade: thriving/healthy green, stable cyan, at_risk amber,
// critical red.
import type { SurvivalGrade } from '@vantra/shared';

const GRADE_LABEL: Record<SurvivalGrade, string> = {
  thriving: 'THRIVING',
  healthy: 'HEALTHY',
  stable: 'STABLE',
  at_risk: 'AT RISK',
  critical: 'CRITICAL',
};

interface SurvivalScoreProps {
  score: number;
  grade: SurvivalGrade;
  size?: 'sm' | 'md' | 'lg';
}

export function SurvivalScore({ score, grade, size = 'md' }: SurvivalScoreProps) {
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const label = GRADE_LABEL[grade];
  return (
    <div className={`survival-score sv-${size} sv-${grade}`} title={`Survival Score ${pct}/100 · ${label}`}>
      <div className="sv-gauge">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="sv-meta">
        <span className="sv-num">{pct}</span>
        <span className="sv-grade">{label}</span>
      </div>
    </div>
  );
}
