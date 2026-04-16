import React from 'react';

type EditProfileModalProps = {
    open: boolean;
    profileName: string;
    onProfileNameChange: (value: string) => void;
    onClose: () => void;
    onSubmit: () => void;
};

export default function EditProfileModal({
    open,
    profileName,
    onProfileNameChange,
    onClose,
    onSubmit
}: EditProfileModalProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[200] qm-modal-backdrop flex items-center justify-center p-4">
            <div className="qm-modal-surface w-full max-w-md p-6 sm:p-7">
                <p className="qm-eyebrow">Workspace Profile</p>
                <h2 className="qm-section-title mt-1">Edit Profile Name</h2>
                <p className="qm-section-copy mt-2">Rename this profile for easier team assignment and inbox tracking.</p>

                <div className="mt-5">
                    <label className="qm-label mb-2">New Name</label>
                    <input
                        type="text"
                        value={profileName}
                        onChange={(e) => onProfileNameChange(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                        className="qm-input"
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
                        className="qm-btn qm-btn-primary h-10 px-5"
                    >
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    );
}
