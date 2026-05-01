# Synthesized Research Papers

## Core Chunking & Segmentation
- **S2 Chunking: A Hybrid Framework for Document Segmentation Through Integrated Spatial and Semantic Analysis** (arXiv:2501.05485v1, Prashant Verma, Jan 2025)
  - Bounding box + embedding → weighted graph → spectral clustering (eigengap)
  - Token-bounded, reading-order reconstruction
  - Implemented as first-class LangChain TextSplitter

## Graph RAG
- **LightRAG: Simple and Fast Retrieval-Augmented Generation** (arXiv:2410.05779v3, Guo et al., Apr 2025)
  - Dual-level retrieval (low-level entities + high-level relations)
  - Graph + vector fusion, incremental update

## Memory Systems
- **SimpleMem: Efficient Lifelong Memory for LLM Agents** (arXiv:2601.02553v3, Liu et al., Jan 2026)
  - Semantic Structured Compression + Online Synthesis + Intent-Aware Planning
  - 26.4% F1 gain, 30× token reduction

- **LightMem: Lightweight and Efficient Memory-Augmented Generation** (arXiv:2510.18866v4, Fang et al., Feb 2026, ICLR 2026)
  - Sensory → Short-term → Long-term (sleep-time offline consolidation)
  - 7.7–29.3% QA accuracy, 38–106× token reduction

- **StructMem: Structured Memory for Long-Horizon Behavior in LLMs** (arXiv:2604.21748v1, Xu et al., Apr 2026)
  - Event-centric dual-perspective extraction + periodic semantic consolidation
  - Temporal + relational structure without rigid schemas

## Multi-Agent & Orchestration
- **Experience as a Compass: Multi-agent RAG with Evolving Orchestration and Agent Prompts** (arXiv:2604.00901v2, Li & Ramakrishnan, Apr 2026)
  - HERA: Hierarchical reward-guided topology sampling + Role-Aware Prompt Evolution
  - +38.69% over baselines, emergent self-organization

## Query & Domain
- **5 Proven Query Translation Techniques To Boost Your RAG Performance** (Towards Data Science, Aug 2024)
  - HyDE, Multi-Query, Step-Back, Rewriting, Intent Clarification

- **PriHA: A RAG-Enhanced LLM Framework for Primary Healthcare Assistant in Hong Kong** (arXiv:2604.14215v1, Chan et al., Apr 2026)
  - Query optimizer + Dual Retrieval Augmented Generation (DRAG)

## Semantic Methods & Autonomy
- **Enhancing Efficiency in Text Splitting: Exploring Semantic Clustering Methods** (Frits Traets, Medium, Mar 2024)
  - K-Means / spectral on embeddings for homogeneous paragraphs

- **AutoResearchClaw** (aiming-lab/AutoResearchClaw, 2026)
  - Fully autonomous & self-evolving research from idea to paper
  - Integrated as the meta-learning / workflow evolution engine

## OMNI-SIMPLEMEM (Bonus)
- **OMNI-SIMPLEMEM: Autoresearch-Guided Discovery of Life-long Multimodal Agent Memory** (arXiv:2604.01007v2, Liu et al., Apr 2026)
  - 411% / 214% F1 gains via autonomous experiment loop — directly inspires our learning layer

All papers are in `/home/workdir/attachments/`. The MemFlow design is a faithful modular synthesis that lets practitioners mix-and-match the best components while maintaining LangChain compatibility and Memgraph persistence.