import React from 'react';
import { CheckCircle2, Circle, CircleCheck, ExternalLink, Sparkles } from 'lucide-react';

type GuideLink = {
    label: string;
    href: string;
};

type OnboardingStep = {
    id: string;
    title: string;
    description: string;
    details: string[];
    whereToGet?: string[];
    guideLinks?: GuideLink[];
    fieldKey?: string;
    fieldLabel?: string;
    fieldPlaceholder?: string;
    fieldType?: string;
};

type OnboardingSetup = Record<string, string> & {
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
};

type OnboardingTutorialModalProps = {
    open: boolean;
    currentStep: OnboardingStep;
    steps: OnboardingStep[];
    stepIndex: number;
    onboardingSetup: OnboardingSetup;
    isCurrentStepValid: boolean;
    isFinalStep: boolean;
    onboardingConnectLoading: boolean;
    activeProfileId: string | null;
    onboardingConnectError: string | null;
    onboardingConnectSuccess: string | null;
    onboardingValidationError: string | null;
    onUpdateField: (field: string, value: string) => void;
    onConnect: () => void;
    onBack: () => void;
    onNext: () => void;
};

export default function OnboardingTutorialModal({
    open,
    currentStep,
    steps,
    stepIndex,
    onboardingSetup,
    isCurrentStepValid,
    isFinalStep,
    onboardingConnectLoading,
    activeProfileId,
    onboardingConnectError,
    onboardingConnectSuccess,
    onboardingValidationError,
    onUpdateField,
    onConnect,
    onBack,
    onNext
}: OnboardingTutorialModalProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[320] qm-modal-backdrop flex items-center justify-center p-4 sm:p-5">
            <div className="qm-modal-surface w-full max-w-4xl overflow-hidden">
                <div className="grid lg:grid-cols-[0.95fr_1.05fr]">
                    <aside className="border-b border-[var(--qm-border)] bg-[#f4f8ff] p-5 sm:p-6 lg:border-b-0 lg:border-r lg:p-7">
                        <div className="inline-flex items-center gap-2 qm-badge qm-badge-brand">
                            <Sparkles className="h-3.5 w-3.5" />
                            WABA Connection Setup
                        </div>
                        <h2 className="mt-4 text-2xl font-extrabold text-[var(--qm-text)]">Connect your WhatsApp business environment</h2>
                        <p className="mt-2 text-sm leading-relaxed text-[var(--qm-text-muted)]">
                            Complete each setup step once. QMessage stores credentials securely and unlocks all operational workspace features after verification.
                        </p>

                        <div className="mt-5 qm-checklist">
                            {steps.map((step, idx) => {
                                const done = idx < stepIndex;
                                const current = idx === stepIndex;
                                return (
                                    <div
                                        key={`tour-step-${step.id}`}
                                        className={`qm-check-item ${current ? 'border-[var(--qm-border-strong)] bg-white' : ''}`}
                                        data-complete={done ? 'true' : 'false'}
                                    >
                                        <span className="qm-check-icon">
                                            {done ? <CircleCheck className="h-3.5 w-3.5" /> : current ? <Circle className="h-3.5 w-3.5" /> : idx + 1}
                                        </span>
                                        <div className="min-w-0">
                                            <p className={`truncate text-sm font-bold ${current ? 'text-[var(--qm-text)]' : 'text-[var(--qm-text-muted)]'}`}>{step.title}</p>
                                            <p className="mt-0.5 text-xs text-[var(--qm-text-soft)]">Step {idx + 1}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        <div className="mt-6 qm-help-block">
                            <p className="text-[11px] font-extrabold uppercase tracking-[0.15em] text-[var(--qm-text-soft)]">Progress</p>
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#d9e6f5]">
                                <div
                                    className="h-full rounded-full bg-[var(--qm-brand)] transition-all duration-300"
                                    style={{ width: `${Math.round(((stepIndex + 1) / Math.max(steps.length, 1)) * 100)}%` }}
                                />
                            </div>
                            <p className="mt-2 text-xs font-semibold text-[var(--qm-text-muted)]">
                                Step {Math.min(stepIndex + 1, steps.length)} of {steps.length}
                            </p>
                        </div>
                    </aside>

                    <section className="p-5 sm:p-6 lg:p-7">
                        <div className="qm-section-heading">
                            <div>
                                <p className="qm-eyebrow">Setup Step</p>
                                <h3 className="qm-section-title mt-1">{currentStep.title}</h3>
                            </div>
                        </div>

                        <p className="qm-section-copy mb-4">{currentStep.description}</p>

                        <div className="qm-card-soft p-4">
                            <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[var(--qm-text-soft)]">What to do</div>
                            <ul className="space-y-2">
                                {currentStep.details.map((detail, idx) => (
                                    <li key={`tour-detail-${stepIndex}-${idx}`} className="flex items-start gap-2 text-sm text-[var(--qm-text)]">
                                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--qm-brand)]" />
                                        <span>{detail}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {currentStep.whereToGet && currentStep.whereToGet.length > 0 && (
                            <div className="qm-help-block mt-4">
                                <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[var(--qm-text-soft)]">Where to get it</div>
                                <ul className="space-y-2">
                                    {currentStep.whereToGet.map((line, idx) => (
                                        <li key={`onboarding-source-${currentStep.id}-${idx}`} className="flex items-start gap-2 text-sm text-[var(--qm-text)]">
                                            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--qm-accent)]" />
                                            <span>{line}</span>
                                        </li>
                                    ))}
                                </ul>
                                {currentStep.guideLinks && currentStep.guideLinks.length > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        {currentStep.guideLinks.map((link) => (
                                            <a
                                                key={`guide-link-${currentStep.id}-${link.href}`}
                                                href={link.href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="qm-btn qm-btn-secondary h-9 px-3 text-[10px]"
                                            >
                                                {link.label}
                                                <ExternalLink className="h-3.5 w-3.5" />
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {currentStep.fieldKey && (
                            <div className="mt-4">
                                <label className="qm-label mb-2">
                                    {currentStep.fieldLabel}
                                </label>
                                <input
                                    type={currentStep.fieldType || 'text'}
                                    value={onboardingSetup[currentStep.fieldKey] || ''}
                                    onChange={(e) => onUpdateField(currentStep.fieldKey!, e.target.value)}
                                    placeholder={currentStep.fieldPlaceholder || ''}
                                    autoFocus
                                    className="qm-input"
                                />
                                {!isCurrentStepValid && (
                                    <div className="qm-status qm-status-warning mt-2">
                                        Enter a valid value to continue.
                                    </div>
                                )}
                            </div>
                        )}

                        {currentStep.id === 'connect' && (
                            <div className="mt-4 space-y-3">
                                <div className="qm-card p-4">
                                    <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[var(--qm-text-soft)]">Review before verify</div>
                                    <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                                        <div className="text-[var(--qm-text-muted)]">WABA ID</div>
                                        <div className="break-all font-bold text-[var(--qm-text)]">{onboardingSetup.wabaId || '-'}</div>
                                        <div className="text-[var(--qm-text-muted)]">Phone Number ID</div>
                                        <div className="break-all font-bold text-[var(--qm-text)]">{onboardingSetup.phoneNumberId || '-'}</div>
                                        <div className="text-[var(--qm-text-muted)]">Access Token</div>
                                        <div className="font-bold text-[var(--qm-text)]">{onboardingSetup.accessToken ? 'Entered' : 'Missing'}</div>
                                        <div className="text-[var(--qm-text-muted)]">Verify Token</div>
                                        <div className="font-bold text-[var(--qm-text)]">{onboardingSetup.verifyToken ? 'Entered' : 'Missing'}</div>
                                    </div>
                                </div>

                                <button
                                    type="button"
                                    onClick={onConnect}
                                    disabled={onboardingConnectLoading || !activeProfileId}
                                    className="qm-btn qm-btn-primary h-11"
                                >
                                    {onboardingConnectLoading ? 'Verifying...' : 'Save and verify connection'}
                                </button>

                                {!activeProfileId && (
                                    <div className="qm-status qm-status-warning">
                                        Waiting for profile to load before verification.
                                    </div>
                                )}
                                {onboardingConnectError && (
                                    <div className="qm-status qm-status-error">{onboardingConnectError}</div>
                                )}
                                {onboardingConnectSuccess && (
                                    <div className="qm-status qm-status-success flex items-center gap-2">
                                        <CheckCircle2 className="h-4 w-4" />
                                        {onboardingConnectSuccess}
                                    </div>
                                )}
                            </div>
                        )}

                        {onboardingValidationError && (
                            <div className="qm-status qm-status-error mt-4">{onboardingValidationError}</div>
                        )}

                        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                            <div className="text-xs font-semibold text-[var(--qm-text-soft)]">Complete each step to unlock dashboard access.</div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={onBack}
                                    disabled={stepIndex === 0 || onboardingConnectLoading}
                                    className="qm-btn qm-btn-secondary h-10 px-4"
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    onClick={onNext}
                                    disabled={onboardingConnectLoading || !isCurrentStepValid}
                                    className="qm-btn qm-btn-primary h-10 px-5"
                                >
                                    {isFinalStep ? 'Enter dashboard' : 'Next'}
                                </button>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
