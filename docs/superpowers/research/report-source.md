# TWI Audio-AI research source report

**Research date:** 2026-08-30  
**Scope:** AI music generation, finishing, evaluation, routing, provenance, privacy, copyright, Cloudflare/Modal orchestration and browser review.  
**Status:** Canonical evidence record. Engineering conclusions are distilled in `../TWI-AUDIO-AI-DEEP-RESEARCH-2026-08-30.md`.

## Method and confidence

The research used current primary sources: provider API schemas, model cards, terms, statutes, regulators, standards bodies, infrastructure documentation and papers. Secondary sources were not used for decisive implementation claims. “High” means directly supported by an active primary source; “medium” means a live probe, exact-tier review or counsel is still needed. Prices, limits, model IDs and terms are dated snapshots and must be configuration.

The search stopped once every decisive question had a primary-source answer or a named uncertainty. Further broad search would mainly repeat marketing or unverifiable aggregators. This is technical/product research, not legal advice. Obtain Swedish/EU counsel before public commercial launch, voice cloning, third-party training/fine-tuning or reliance on a copyright exception.

## Google Lyria and Gemini

| ID | Finding and evidence | Engineering consequence |
|---|---|---|
| GO-1 | `lyria-3-clip-preview` makes 30 s clips; `lyria-3-pro-preview` makes songs up to about 184 s via Interactions and can return WAV. It accepts text, lyrics and up to ten images. [Gemini music generation](https://ai.google.dev/gemini-api/docs/music-generation), [Vertex release notes](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes). High. | TWI's 240 s ceiling exceeds Lyria. Reject before billing or route elsewhere; never silently crop/segment. |
| GO-2 | Current prices: $0.04 Clip, $0.08 Pro, no free tier; rate limits are project/tier-specific. [Pricing](https://ai.google.dev/gemini-api/docs/pricing), [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits). High, mutable. | Two candidates start at $0.16. Version price policy; handle 429 dynamically. |
| GO-3 | Google pages conflict between 44.1 and 48 kHz stereo. Generation is nondeterministic. [Guide](https://ai.google.dev/gemini-api/docs/music-generation), [model page](https://ai.google.dev/gemini-api/docs/models/lyria-3-pro-preview), [model card](https://deepmind.google/models/model-cards/lyria-3-5/). High for the conflict. | Probe every output; persist actual codec/rate/channels/duration. A replay is not identity. |
| GO-4 | Lyria is single-turn, can interleave structure/lyrics/audio, rejects artist-voice/copyrighted-lyric requests and embeds SynthID. [Guide](https://ai.google.dev/gemini-api/docs/music-generation), [SynthID](https://deepmind.google/models/synthid/). High. | Parse all steps, preserve returned text, map safety errors, record watermark; do not promise editing. |
| GO-5 | Preview models can retire; no shutdown date was announced at research time. [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations). High. | Versioned registry, kill switch, canary and migration path. |
| GO-6 | Gemini inline media is generally constrained to under 20 MB per request; Files API is recommended for larger/reused data. [Images](https://ai.google.dev/gemini-api/docs/image-understanding), [Files](https://ai.google.dev/gemini-api/docs/files). Medium-high for Lyria applicability. | Normalize provider thumbnails and cap aggregate bytes; originals and derivative hashes stay in R2. |
| GO-7 | Paid services have stronger non-training terms, but retention/abuse logging depends on product and eligibility; Interactions may store state. [Terms](https://ai.google.dev/gemini-api/terms), [ZDR](https://ai.google.dev/gemini-api/docs/zdr). Medium-high. | Use paid EEA service, minimize data/server state and record retention mode. |

## Provider decision matrix

| Provider | Verified fit | Decision and caveat |
|---|---|---|
| Stable Audio 3 | Text/audio conditioning, editing/inpainting, async, up to 380 s, 44.1 kHz stereo, MP3/WAV. | **P0 instrumental/SFX** plus local fallback. No equally verified lyric/vocal pipeline. Community License is not OSI open source and changes over $1M revenue. [API](https://platform.stability.ai/docs/api-reference), [pricing](https://platform.stability.ai/pricing), [license](https://stability.ai/license), [family](https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models). |
| Eleven Music v2 | Official API/SDK; 3–600 s schema, chunks, lyrics/vocals, seeds, references, inpainting, extension, streaming, stems, optional C2PA. | **P0 vocal/full-song/editing**, subject to exact-tier terms. Docs disagree on 5 vs 10 min; pure-play uses can face special terms. [Compose](https://elevenlabs.io/docs/api-reference/music/compose), [inpainting](https://elevenlabs.io/docs/eleven-api/guides/how-to/music/inpainting), [stems](https://elevenlabs.io/docs/api-reference/music/separate-stems), [terms](https://elevenlabs.io/music-api-terms), [pricing](https://elevenlabs.io/pricing/api). |
| Google Lyria 3 | Cheap text/image/lyrics with SynthID. | **P1 preview flag**, not sole foundation: 184 s, preview lifecycle, rate conflict, no editing. |
| MiniMax Music 2.6 | Lyrics, instrumental, cover/reference, streaming, MP3/WAV/PCM, up to 5 min; $0.15/song; published 120 RPM/20 connections. | **P1 fallback**; broader input/output improvement rights and weak training provenance. [API](https://platform.minimax.io/docs/api-reference/music-generation), [pricing](https://platform.minimax.io/docs/guides/pricing-paygo), [limits](https://platform.minimax.io/docs/guides/rate-limits), [terms](https://platform.minimax.io/protocol/terms-of-service). |
| Mureka | Song/instrumental/streaming/extend/remix/stems/region-edit/soundtrack APIs. | **P2 pilot**; no stable public unit price or granular training disclosure, rapid version churn. [Docs](https://platform.mureka.ai/docs/), [changelog](https://platform.mureka.ai/docs/en/changelog.html), [FAQ](https://platform.mureka.ai/docs/en/faq.html). |
| Suno | Login-gated official portal exists. | **Quarantine.** Public contract/pricing/limits unverifiable; disclosed training and broad content licence add risk. [Portal](https://platform.suno.com/auth/login?returnTo=/), [terms](https://suno.com/terms/), [disclosure](https://help.suno.com/en/articles/9709569). |
| Udio | No public API. | No adapter. [Official status](https://help.udio.com/en/articles/10756277-udio-public-api). |
| Adobe Generate Soundtrack | GA UI, 5 s–5 min video-aware instrumental WAV and Content Credentials. | Inspiration only; no public music endpoint. [Product](https://www.adobe.com/products/firefly/features/ai-music-generator.html), [developer APIs](https://developer.adobe.com/audio-video-firefly-services/). |

Licence gates: MusicGen code is MIT but weights CC-BY-NC ([card](https://github.com/facebookresearch/audiocraft/blob/main/model_cards/MUSICGEN_MODEL_CARD.md)); Stable Audio Open 1.0 is about 47 s ([card](https://huggingface.co/stabilityai/stable-audio-open-1.0)); ACE-Step 1.5 is promising/MIT but new and weakly disclosed ([card](https://huggingface.co/ACE-Step/Ace-Step1.5)); YuE is Apache-2.0 but operationally heavy and weakly documented ([card](https://huggingface.co/m-a-p/YuE-s1-7B-anneal-en-cot)); AudioX is non-commercial ([repo](https://github.com/ZeyueT/AudioX)). Managed hosting never overrides weight licensing.

## Cloudflare and Modal

| ID | Finding and evidence | Engineering consequence |
|---|---|---|
| CF-1 | Workflow IDs match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, max 100 chars; step/event payload max 1 MiB. [Limits](https://developers.cloudflare.com/workflows/reference/limits/). High. | `${jobId}:${attempt}` is invalid. Use shared `${jobId}--${attempt}`-style builder; audio remains in R2. |
| CF-2 | Steps retry and external calls can succeed while their response is lost. [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/). High. | Never blindly retry an ambiguous paid call. Persist submission claim/request ID and `charged: null`; reconcile. |
| CF-3 | `waitForEvent` is durable, early events buffer, waiting consumes no concurrency. [Events](https://developers.cloudflare.com/workflows/build/events-and-parameters/), [pricing](https://developers.cloudflare.com/workflows/reference/pricing/). High. | Authenticated Modal callback + exact job/attempt/call event and replay protection. |
| CF-4 | Completed Workflow state retention is 3 days Free/30 Paid. [Limits](https://developers.cloudflare.com/workflows/reference/limits/). High. | D1/R2, not Workflow, is business history. |
| CF-5 | D1 `batch()` is transactional. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [limits](https://developers.cloudflare.com/d1/platform/limits/). High. | Reuse `TwiRepository` and atomic publication; unique event/idempotency keys. |
| CF-6 | R2 metadata max 8 KiB; immutable keys avoid same-key write throttling; `head`/checksums exist. [Limits](https://developers.cloudflare.com/r2/platform/limits/), [API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). High. | Canonical provenance sidecar; immutable keys; `head`/checksum validation. |
| MO-1 | Modal supports `spawn`/call ID, R2 mounts and proxy auth. [Async](https://modal.com/docs/guide/webhook-timeouts), [R2](https://modal.com/docs/guide/cloud-bucket-mounts), [auth](https://modal.com/docs/guide/webhook-proxy-auth). High. | CPU finishing, scoped secrets/R2, signed callback. No GPU without measurement. |

## Audio, provenance and browser review

| ID | Finding and evidence | Engineering consequence |
|---|---|---|
| AU-1 | BS.1770 defines loudness/true peak; EBU R128's -23 LUFS is broadcast-specific. [BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en), [R128](https://tech.ebu.ch/publications/r128). High. | Loudness is delivery metadata, not aesthetic quality. |
| AU-2 | Spotify and Apple adjust playback; they do not require rewriting an archival master to -14 LUFS. [Spotify](https://support.spotify.com/se/artists/article/loudness-normalization/), [Apple Digital Masters](https://www.apple.com/apple-music/apple-digital-masters/docs/apple-digital-masters.pdf). High. | Preserve raw/archive; make a separate -14 LUFS/-1 dBTP review preview. |
| AU-3 | FFmpeg `loudnorm` supports linear/dynamic; dynamic upsamples to 192 kHz. [FFmpeg](https://ffmpeg.org/ffmpeg-filters.html#loudnorm). High. | Record command/version, resample explicitly, reject dynamic processing for archive. |
| AU-4 | FLAC is RFC 9639; BWF is preservation-oriented. [FLAC](https://www.xiph.org/flac/2024/12/19/rfc-9639-published.html), [BWF](https://www.loc.gov/preservation/digital/formats/fdd/fdd000357.shtml). High. | Keep provider original bit-for-bit; lossless derivatives never replace it. |
| AU-5 | C2PA 2.4 supports signed/tamper-evident audio provenance, but proves neither truth nor ownership. [Spec](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html). High. | Signed JSON sidecar now; optional embedded C2PA after interoperability tests; preserve provider marks. |
| AU-6 | One AudioContext can route media through gain nodes. [Web Audio](https://www.w3.org/TR/webaudio-1.0/), [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Using_Web_Audio_API). High. | Two media elements + one AudioContext/Gain graph; preview MP3, drift correction, private range delivery. |

## Evaluation science

Codec-token autoregression ([MusicGen](https://arxiv.org/abs/2306.05284)), timing-conditioned diffusion ([Stable Audio](https://arxiv.org/abs/2402.04825)), flow matching with local controls ([JASCO](https://arxiv.org/abs/2406.10970)) and masked decoding ([MAGNeT](https://arxiv.org/abs/2401.04577)) have different latency, control and codec trade-offs; architecture labels do not predict product quality.

Long-form form/coherence is separate from local fidelity/alignment ([long-form diffusion](https://arxiv.org/abs/2404.10301), [structural critique](https://arxiv.org/abs/2209.00182)). FAD is set-level and sensitive to N, embeddings and reference corpus ([FAD](https://arxiv.org/abs/1812.08466), [music adaptation](https://arxiv.org/abs/2311.01616)); CLAP/MuLan measure semantic alignment, not musicality/mix ([CLAP](https://arxiv.org/abs/2211.06687), [MuLan](https://research.google/pubs/mulan-a-joint-embedding-of-music-audio-and-natural-language/)). MusicPrefs finds weak human-ranking correlation for standard FAD and stronger MAD/MERT but still retains humans ([paper](https://gclef-cmu.org/static/pdfs/2025huangaligning.pdf)). Public benchmarks can be contaminated ([CLaMP 3](https://aclanthology.org/2025.findings-acl.133.pdf)).

Open-ended songs need blinded pairwise comparison, not fake MUSHRA. Use MUSHRA for codec/separation/editing with real references/anchors ([BS.1534-3](https://www.itu.int/rec/R-REC-BS.1534-3-201510-I/en)); subtle impairments can use [BS.1116-3](https://www.itu.int/rec/R-REC-BS.1116-3-201502-I/en). Stem evaluation combines SDR variants, leakage, reconstruction, silence, runtime and listening; benchmark BS-RoFormer-class systems ([paper](https://arxiv.org/abs/2309.02612)) on MUSDB18HQ ([dataset](https://zenodo.org/records/1117371)) plus private hard cases. Demucs is archived ([repo](https://github.com/facebookresearch/demucs)). A seed is not cross-hardware reproducibility ([PyTorch](https://docs.pytorch.org/docs/stable/notes/randomness.html), [Diffusers](https://huggingface.co/docs/diffusers/main/using-diffusers/reusing_seeds)).

## Law, privacy and transparency

| ID | Finding and evidence | Product consequence |
|---|---|---|
| LAW-1 | EU DSM Article 4 TDM applies to lawfully accessible works only where rights were not appropriately reserved. [Directive 2019/790](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=uriserv%3AOJ.L_.2019.130.01.0092.01.ENG). High, fact-specific. | Publicly reachable is not freely trainable. Prefer owned/licensed data; maintain rights ledger/opt-outs. |
| LAW-2 | AI Act Article 53 requires GPAI copyright policy and training-content summary. [AI Act](https://eur-lex.europa.eu/eli/reg/2024/1689/2026-07-27/eng/pdf). High. | Due diligence captures provider policy, training summary, model/version/date. |
| LAW-3 | Article 50 applies from 2 Aug 2026: synthetic audio marking must be machine-readable/detectable where feasible; deepfake deployment also requires disclosure. [Act](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX%3A32024R1689), [Commission FAQ](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act). High. | Preserve machine marks and provenance; visibly disclose synthetic likeness/deepfakes. Counsel must classify TWI's provider/deployer role. |
| LAW-4 | AI models are not automatically anonymous; legitimate interest needs necessity/balancing; unlawful training data can taint deployment. [EDPB 28/2024](https://www.edpb.europa.eu/system/files/2024-12/edpb_opinion_202428_ai-models_en.pdf). High. | Voice/reference uploads need legal basis, explicit authority, retention/deletion, access control and processor/transfer assessment. |
| LAW-5 | USCO says purely AI-determined expression is not copyrightable; human expression, arrangement/modification may be, case by case; prompting alone is generally insufficient. [Announcement](https://www.copyright.gov/newsnet/2025/1060.html), [report](https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf). High for US policy. | Preserve lyrics/melody/edit/arrangement/selection history. Provider output rights do not guarantee copyright. |
| LAW-6 | Contractual output rights do not establish copyright, non-infringement or performer/publicity clearance. | Separate commercial-rights tier, copyright claim, reference rights, voice consent and similarity review. |

## Required provenance record

Store immutable job/attempt/candidate/asset IDs; parent hashes; provider/product/model/version/region/capability snapshot; prompt and user-input hashes; provider request ID/seed/times/latency/cost/charge certainty; actual media properties plus container and decoded-PCM hashes; watermark state; every transform with tool/container/command digest and measurements; retention/terms/commercial tier snapshots; human contribution/edit log; originality review; canonical JSON hash and optional signature/C2PA.

## Evidence-bounded unknowns

1. Lyria's actual WAV rate, duration adherence, output multiplicity, image behavior, retention and error/charge semantics on the paid TWI project.
2. Provider idempotency/reconciliation after a timeout where billing may have occurred.
3. Eleven's effective tier duration/features/commercial terms.
4. C2PA interoperability in chosen FLAC/MP3/browser/distribution chain.
5. Article 50 role allocation and Swedish enforcement for private/public TWI modes.
6. Swedish/EU copyrightability of the exact human-AI workflow.
7. Metric thresholds on TWI's Swedish/English genres and listeners.

