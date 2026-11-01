"""Work around VK subtitles with null titles (yt-dlp issue #17588)."""
from yt_dlp.extractor.vk import VKIE as _VKIE


def _fix_subtitle_titles(value):
    if isinstance(value, dict):
        subtitles = value.get('subs')
        if isinstance(subtitles, list):
            for subtitle in subtitles:
                if isinstance(subtitle, dict) and not subtitle.get('title'):
                    subtitle['title'] = 'subtitles.srt'
        for child in value.values():
            _fix_subtitle_titles(child)
    elif isinstance(value, list):
        for child in value:
            _fix_subtitle_titles(child)


class _VkSubtitlesIE(_VKIE, plugin_name='stream_companion'):
    def _download_payload(self, *args, **kwargs):
        payload = super()._download_payload(*args, **kwargs)
        _fix_subtitle_titles(payload)
        return payload
