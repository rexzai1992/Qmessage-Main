import React from 'react';

type AddProfileModalProps = {
    open: boolean;
    profileName: string;
    isCreatingProfile: boolean;
    onProfileNameChange: (value: string) => void;
    onClose: () => void;
    onSubmit: () => void;
};

export default function AddProfileModal({
    open,
    profileName,
    isCreatingProfile,
    onProfileNameChange,
    onClose,
    onSubmit
}: AddProfileModalProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[200] qm-modal-backdrop flex items-center justify-center p-4">
            <div className="qm-modal-surface w-full max-w-md p-6 sm:p-7">
                <p className="qm-eyebrow">Workspace Profile</p>
                <h2 className="qm-section-title mt-1">Add New Profile</h2>
                <p className="qm-section-copy mt-2">Create a new profile to separate team workflows and channel settings.</p>

                <div className="mt-5">
                    <label className="qm-label mb-2">Profile Name</label>
                    <input
                        type="text"
                        placeholder="e.g. Sales Account, Support Bot"
                        value={profileName}
                        onChange={(e) => onProfileNameChange(e.target.value)}
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
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onSubmit}
                        disabled={isCreatingProfile || !profileName.trim()}
                        className="qm-btn qm-btn-primary h-10 px-5"
                    >
                        {isCreatingProfile ? 'Creating...' : 'Create Profile'}
                    </button>
                </div>
            </div>
        </div>
    );
}
