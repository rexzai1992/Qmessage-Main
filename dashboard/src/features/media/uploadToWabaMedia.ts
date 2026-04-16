export type UploadedWabaMedia = {
    mediaId: string
    mimeType: string
    sizeBytes: number
    fileName: string
}

function readTrimmed(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function readResponseErrorMessage(status: number, bodyText: string, fallback: string): string {
    const trimmed = readTrimmed(bodyText)
    if (!trimmed) return `${fallback} (HTTP ${status})`

    try {
        const parsed = JSON.parse(trimmed)
        const apiError = readTrimmed((parsed as any)?.error)
        if (apiError) return apiError
    } catch {
        // non-JSON response body
    }

    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 180)
    return snippet ? `${fallback} (HTTP ${status}): ${snippet}` : `${fallback} (HTTP ${status})`
}

export async function uploadFileToWabaMedia(args: {
    apiBaseUrl: string
    profileId: string
    sessionToken: string
    file: File
}): Promise<UploadedWabaMedia> {
    const { apiBaseUrl, profileId, sessionToken, file } = args
    const fileName = file.name || `media_${Date.now()}`
    const mimeType = file.type || 'application/octet-stream'
    const params = new URLSearchParams({ profileId })

    const uploadRes = await fetch(`${apiBaseUrl}/api/waba/media/upload?${params.toString()}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${sessionToken}`,
            'Content-Type': mimeType,
            'x-file-name': fileName,
            'x-file-type': mimeType,
            'x-messaging-product': 'whatsapp'
        },
        body: file
    })

    const uploadRawText = await uploadRes.text()
    const uploadData = (() => {
        try {
            return uploadRawText ? JSON.parse(uploadRawText) : null
        } catch {
            return null
        }
    })()

    if (!uploadRes.ok || !uploadData?.success) {
        throw new Error(
            uploadData?.error
            || readResponseErrorMessage(uploadRes.status, uploadRawText, 'Failed to upload media to WhatsApp.')
        )
    }

    const mediaId = readTrimmed(uploadData?.data?.id || uploadData?.data?.media_id)
    if (!mediaId) {
        throw new Error('WhatsApp media upload succeeded but did not return a media ID.')
    }

    return {
        mediaId,
        mimeType,
        sizeBytes: file.size,
        fileName
    }
}
