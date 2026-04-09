import React from 'react';

type BottomNavItem = {
    id: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badgeCount?: number;
};

type BottomNavBarProps = {
    items: BottomNavItem[];
    activeId: string;
    onSelect: (id: string) => void;
};

export default function BottomNavBar({ items, activeId, onSelect }: BottomNavBarProps) {
    const totalItems = Math.max(items.length, 1);
    const activeIndex = Math.max(
        0,
        items.findIndex((item) => item.id === activeId)
    );

    return (
        <nav
            className="fixed bottom-0 inset-x-0 z-[180] border-t border-[#dfe5ea] bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/90 lg:hidden"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.4rem)' }}
            aria-label="Primary"
        >
            <div
                className="relative grid h-[64px] px-1"
                style={{ gridTemplateColumns: `repeat(${totalItems}, minmax(0, 1fr))` }}
            >
                <div
                    className="pointer-events-none absolute left-1 top-1 bottom-1 rounded-xl bg-[#e9f7f4] shadow-[0_4px_16px_rgba(0,168,132,0.18)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
                    style={{
                        width: `calc((100% - 0.5rem) / ${totalItems})`,
                        transform: `translateX(${activeIndex * 100}%)`
                    }}
                />
                {items.map((item) => {
                    const Icon = item.icon;
                    const active = item.id === activeId;
                    const normalizedBadgeCount = Math.max(0, Number(item.badgeCount) || 0);
                    return (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => onSelect(item.id)}
                            className={`relative z-10 flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-bold transition-all duration-200 ${
                                active
                                    ? 'text-[#008f6f]'
                                    : 'text-[#5f6f7a] hover:text-[#3f4e57]'
                            }`}
                            aria-current={active ? 'page' : undefined}
                        >
                            <Icon className={`h-4 w-4 transition-transform duration-200 ${active ? '-translate-y-[1px]' : ''}`} />
                            <span className={`truncate max-w-full transition-transform duration-200 ${active ? '-translate-y-[1px]' : ''}`}>
                                {item.label}
                            </span>
                            {normalizedBadgeCount > 0 && (
                                <span className="absolute right-1.5 top-1 min-w-[16px] h-4 rounded-full border border-white bg-[#ef4444] px-1 text-[9px] leading-4 text-white text-center">
                                    {normalizedBadgeCount > 99 ? '99+' : normalizedBadgeCount}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
