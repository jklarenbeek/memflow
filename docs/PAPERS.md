# Synthesized Research Papers

> All reference PDFs are archived in [`docs/refs/`](refs/) for offline access and traceability.

## Core Chunking & Segmentation
- **S2 Chunking: A Hybrid Framework for Document Segmentation Through Integrated Spatial and Semantic Analysis** (arXiv:2501.05485v1, Prashant Verma, Jan 2025)
  - Bounding box + embedding → weighted graph → spectral clustering (eigengap)
  - Token-bounded, reading-order reconstruction
  - Implemented as first-class LangChain TextSplitter
  - 📄 [`docs/refs/2501.05485v1.pdf`](refs/2501.05485v1.pdf)

## Graph RAG
- **LightRAG: Simple and Fast Retrieval-Augmented Generation** (arXiv:2410.05779v3, Guo et al., Apr 2025)
  - Dual-level retrieval (low-level entities + high-level relations)
  - Graph + vector fusion, incremental update
  - 📄 [`docs/refs/2410.05779v3.pdf`](refs/2410.05779v3.pdf)

## Memory Systems
- **SimpleMem: Efficient Lifelong Memory for LLM Agents** (arXiv:2601.02553v3, Liu et al., Jan 2026)
  - Semantic Structured Compression + Online Synthesis + Intent-Aware Planning
  - 26.4% F1 gain, 30× token reduction
  - 📄 [`docs/refs/2601.02553v3.pdf`](refs/2601.02553v3.pdf)

- **LightMem: Lightweight and Efficient Memory-Augmented Generation** (arXiv:2510.18866v4, Fang et al., Feb 2026, ICLR 2026)
  - Sensory → Short-term → Long-term (sleep-time offline consolidation)
  - 7.7–29.3% QA accuracy, 38–106× token reduction
  - 📄 [`docs/refs/2510.18866v4.pdf`](refs/2510.18866v4.pdf)

- **StructMem: Structured Memory for Long-Horizon Behavior in LLMs** (arXiv:2604.21748v1, Xu et al., Apr 2026)
  - Event-centric dual-perspective extraction + periodic semantic consolidation
  - Temporal + relational structure without rigid schemas
  - 📄 [`docs/refs/2604.21748v1.pdf`](refs/2604.21748v1.pdf)

## Multi-Agent & Orchestration
- **Experience as a Compass: Multi-agent RAG with Evolving Orchestration and Agent Prompts** (arXiv:2604.00901v2, Li & Ramakrishnan, Apr 2026)
  - HERA: Hierarchical reward-guided topology sampling + Role-Aware Prompt Evolution
  - +38.69% over baselines, emergent self-organization
  - 📄 [`docs/refs/2604.00901v2.pdf`](refs/2604.00901v2.pdf)

- **TradingAgents: Multi-Agents LLM Financial Trading Framework** (arXiv:2412.20138v7, Xiao et al., Jun 2025)
  - Multi-agent trading firm simulation: fundamental/sentiment/technical analysts + bull/bear debates
  - Structured state management + outcome-grounded memory (pending decisions → resolved with real market feedback → reflection injection)
  - 📄 [`docs/refs/2412.20138v7.pdf`](refs/2412.20138v7.pdf)

## Query & Domain
- **5 Proven Query Translation Techniques To Boost Your RAG Performance** (Towards Data Science, Aug 2024)
  - HyDE, Multi-Query, Step-Back, Rewriting, Intent Clarification
  - 📄 [`docs/refs/5 Proven Query Translation Techniques.pdf`](refs/5%20Proven%20Query%20Translation%20Techniques.pdf)

- **PriHA: A RAG-Enhanced LLM Framework for Primary Healthcare Assistant in Hong Kong** (arXiv:2604.14215v1, Chan et al., Apr 2026)
  - Query optimizer + Dual Retrieval Augmented Generation (DRAG)
  - 📄 [`docs/refs/2604.14215v1.pdf`](refs/2604.14215v1.pdf)

## Semantic Methods & Autonomy
- **Enhancing Efficiency in Text Splitting: Exploring Semantic Clustering Methods** (Frits Traets, Medium, Mar 2024)
  - K-Means / spectral on embeddings for homogeneous paragraphs
  - 📄 [`docs/refs/Exploring Semantic Clustering Methods.pdf`](refs/Exploring%20Semantic%20Clustering%20Methods.pdf)

- **AutoResearchClaw** (aiming-lab/AutoResearchClaw, 2026)
  - Fully autonomous & self-evolving research from idea to paper
  - Integrated as the meta-learning / workflow evolution engine
  - 📄 [`docs/refs/AutoResearchClaw.pdf`](refs/AutoResearchClaw.pdf)

## Self-Evolution Layer (May 2026)

- **MASFactory: A Graph-centric Framework for Orchestrating LLM-Based Multi-Agent Systems with Vibe Graphing** (arXiv:2603.06007v1, Zhou et al., Mar 2026)
  - Intent-to-workflow compilation via "Vibe Graphing"; pluggable `ContextBlock` protocol
  - Adapted as `IntentCompilerModule` (Phase 4)
  - 📄 [`docs/refs/2603.06007v1.pdf`](refs/2603.06007v1.pdf)

- **Trace2Skill: Distill Trajectory-Local Lessons into Transferable Agent Skills** (arXiv:2603.25158v4, Chen et al., Mar 2026)
  - Offline parallel trace analysis → hierarchical skill consolidation into declarative prompt packs
  - Adopted as `Trace2SkillModule`, `TraceClusterModule`, `SkillMergeModule`, `SkillInjectorModule` (Phase 2)
  - 📄 [`docs/refs/2603.25158v4.pdf`](refs/2603.25158v4.pdf)

- **Milkyway: The World Leaks the Future: Harness Evolution for Future Prediction Agents** (arXiv:2604.15719v2, Xu et al., Apr 2026)
  - Persistent prediction harness with internal feedback (temporal contrasts) + retrospective validation
  - Adopted as `HarnessEvolverModule` (Phase 3)
  - 📄 [`docs/refs/2604.15719v2.pdf`](refs/2604.15719v2.pdf)

- **Characterizing Model-Native Skills (AutoSkill)** (arXiv:2604.17614v1, Wang et al., Apr 2026)
  - Activation-space PCA for skill characterization; adapted to embedding-space PCA for API-only constraint
  - Adapted as `SkillBasisExtractorModule`, `SkillGapAnalyzerModule` (Phase 4, optional)
  - 📄 [`docs/refs/2604.17614v1.pdf`](refs/2604.17614v1.pdf)

- **Contextual Agentic Memory is a Memo, Not True Memory** (arXiv:2604.27707v1, Li et al., Apr 2026)
  - Theoretical argument: retrieval-based memory hits a generalization ceiling; weight-based consolidation is the missing neocortical path
  - Justification for `SLMDatasetExporterModule` (Phase 1)
  - 📄 [`docs/refs/2604.27707v1.pdf`](refs/2604.27707v1.pdf)

> See the [`docs/PROPOSAL.md`](PROPOSAL.md) suite (PROPOSAL.md through PROPOSAL_04.md) for the full phased implementation plan.

## OMNI-SIMPLEMEM (Bonus)
- **OMNI-SIMPLEMEM: Autoresearch-Guided Discovery of Life-long Multimodal Agent Memory** (arXiv:2604.01007v2, Liu et al., Apr 2026)
  - 411% / 214% F1 gains via autonomous experiment loop — directly inspires our learning layer
  - 📄 [`docs/refs/2604.01007v2.pdf`](refs/2604.01007v2.pdf)

The MemFlow design is a faithful modular synthesis that lets practitioners mix-and-match the best components while maintaining LangChain compatibility and Memgraph persistence.