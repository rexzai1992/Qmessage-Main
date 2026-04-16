import { useCallback, useLayoutEffect, useState } from 'react';

export const useElementSize = <T extends HTMLElement>() => {
    const [node, setNode] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const ref = useCallback((el: T | null) => {
        setNode((prev) => (prev === el ? prev : el));
    }, []);

    useLayoutEffect(() => {
        if (!node) return;

        const update = () => {
            const nextWidth = node.clientWidth;
            const nextHeight = node.clientHeight;
            setSize((prev) => (
                prev.width === nextWidth && prev.height === nextHeight
                    ? prev
                    : { width: nextWidth, height: nextHeight }
            ));
        };

        update();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }

        const observer = new ResizeObserver(() => update());
        observer.observe(node);
        return () => observer.disconnect();
    }, [node]);

    return { ref, size };
};
