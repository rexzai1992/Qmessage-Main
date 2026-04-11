type MediaDownloadStatus = 'requesting' | 'downloading' | 'processing' | 'error';

export interface MediaLoadingPlaceholderProgress {
    percent: number;
    status: MediaDownloadStatus;
}

interface MediaLoadingPlaceholderProps {
    compact?: boolean;
    progress: MediaLoadingPlaceholderProgress | null;
    onRetry: () => void;
}

export default function MediaLoadingPlaceholder({
    compact = false,
    progress,
    onRetry
}: MediaLoadingPlaceholderProps) {
    if (!progress) {
        return (
            <div className={`animate-pulse space-y-2 ${compact ? 'w-32' : 'w-28'}`}>
                <div className="h-3 rounded bg-[#e8edf1]" />
                <div className="h-3 rounded bg-[#eef2f5]" />
            </div>
        );
    }

    const isError = progress.status === 'error';
    const percent = Math.max(1, Math.min(100, Math.round(progress.percent)));
    const statusLabel =
        progress.status === 'requesting'
            ? 'Requesting file...'
            : progress.status === 'downloading'
                ? 'Downloading file...'
                : progress.status === 'processing'
                    ? 'Preparing preview...'
                    : 'Download failed';

    return (
        <div className={`space-y-2 ${compact ? 'w-44' : 'w-52'}`}>
            <div className="h-2 rounded-full bg-[#e8edf1] overflow-hidden">
                <div
                    className={`h-full transition-all duration-300 ${isError ? 'bg-rose-400' : 'bg-[#00a884]'}`}
                    style={{ width: `${isError ? Math.max(percent, 12) : percent}%` }}
                />
            </div>
            <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] font-semibold ${isError ? 'text-rose-600' : 'text-[#54656f]'}`}>
                    {statusLabel}
                </span>
                {isError ? (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            onRetry();
                        }}
                        className="text-[10px] font-bold text-rose-600 hover:text-rose-700 hover:underline"
                    >
                        Retry
                    </button>
                ) : (
                    <span className="text-[10px] font-semibold text-[#54656f]">{percent}%</span>
                )}
            </div>
        </div>
    );
}
