import React from 'react';

type NewChatModalProps = {
    open: boolean;
    phoneNumber: string;
    onPhoneNumberChange: (value: string) => void;
    onClose: () => void;
    onSubmit: () => void;
};

export default function NewChatModal({
    open,
    phoneNumber,
    onPhoneNumberChange,
    onClose,
    onSubmit
}: NewChatModalProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[200] qm-modal-backdrop flex items-center justify-center p-4">
            <div className="qm-modal-surface w-full max-w-md p-6 sm:p-7">
                <p className="qm-eyebrow">Start Conversation</p>
                <h2 className="qm-section-title mt-1">Direct Message</h2>
                <p className="qm-section-copy mt-2">Enter a phone number with country code, for example: 60123456789.</p>

                <div className="mt-5">
                    <label className="qm-label mb-2">Phone Number</label>
                    <input
                        type="text"
                        placeholder="60123456789"
                        value={phoneNumber}
                        onChange={(e) => onPhoneNumberChange(e.target.value)}
                        className="qm-input"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                    />
                </div>

                <div className="mt-6 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="qm-btn qm-btn-secondary h-10 px-4"
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        className="qm-btn qm-btn-primary h-10 px-5"
                    >
                        Open Chat
                    </button>
                </div>
            </div>
        </div>
    );
}
