// Editorial taxonomy shared by prompts, validation, scoring and rendering.

export const CATEGORIES = [
  "force_movement", "military_buildup", "mobilisation", "reservists", "military_logistics", "exercise", "snap_exercise",
  "air_activity", "airspace_violation", "air_interception", "drone_incident", "naval_activity", "border_incident",
  "sabotage", "arson", "espionage", "cyberattack", "critical_infrastructure", "undersea_infrastructure",
  "electronic_warfare", "gps_interference", "nuclear_signalling", "nuclear_posture", "official_warning",
  "intelligence_assessment", "article_4", "article_5", "nato_reinforcement", "us_force_posture",
  "belarus_russia_integration", "civil_defence", "evacuation_preparation", "military_readiness",
  "defence_policy", "diplomatic_escalation", "diplomatic_deescalation", "information_operation",
  "negative_evidence", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATEMENT_TYPES = ["FACT", "OFFICIAL_CLAIM", "OSINT_CLAIM", "ASSESSMENT", "ANALYSIS", "UNCONFIRMED"] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const SIGNALS = ["escalation", "counter", "neutral"] as const;
export type Signal = (typeof SIGNALS)[number];

export const NOVELTY = ["NEW_EVENT", "SIGNIFICANT_UPDATE", "MINOR_UPDATE", "DUPLICATE", "BACKGROUND", "OLD_RESURFACED"] as const;
export type Novelty = (typeof NOVELTY)[number];

/** How strongly a category moves the escalation index when observed (before importance/confidence). */
export const CATEGORY_WEIGHT: Partial<Record<Category, number>> = {
  article_5: 1, article_4: 0.9, mobilisation: 0.9, nuclear_posture: 0.9, military_buildup: 0.8, evacuation_preparation: 0.8,
  airspace_violation: 0.7, drone_incident: 0.65, sabotage: 0.7, undersea_infrastructure: 0.65, force_movement: 0.6,
  snap_exercise: 0.6, military_readiness: 0.6, official_warning: 0.55, intelligence_assessment: 0.5, nuclear_signalling: 0.55,
  cyberattack: 0.5, critical_infrastructure: 0.5, border_incident: 0.55, air_interception: 0.4, arson: 0.45, espionage: 0.4,
  gps_interference: 0.35, electronic_warfare: 0.4, naval_activity: 0.35, air_activity: 0.3, reservists: 0.5, civil_defence: 0.4,
  nato_reinforcement: 0.45, us_force_posture: 0.4, belarus_russia_integration: 0.4, diplomatic_escalation: 0.45,
  military_logistics: 0.45, exercise: 0.25, defence_policy: 0.2, information_operation: 0.25,
  diplomatic_deescalation: 0.5, negative_evidence: 0.5, other: 0.1,
};

export const CATEGORY_RU: Record<Category, string> = {
  force_movement: "перемещение войск", military_buildup: "наращивание сил", mobilisation: "мобилизация", reservists: "резервисты",
  military_logistics: "военная логистика", exercise: "учения", snap_exercise: "внезапные учения", air_activity: "активность авиации",
  airspace_violation: "нарушение воздушного пространства", air_interception: "перехват", drone_incident: "инцидент с дронами",
  naval_activity: "активность флота", border_incident: "инцидент на границе", sabotage: "диверсия", arson: "поджог",
  espionage: "шпионаж", cyberattack: "кибератака", critical_infrastructure: "критическая инфраструктура",
  undersea_infrastructure: "подводная инфраструктура", electronic_warfare: "РЭБ", gps_interference: "помехи GPS",
  nuclear_signalling: "ядерная риторика", nuclear_posture: "ядерная готовность", official_warning: "официальное предупреждение",
  intelligence_assessment: "оценка разведки", article_4: "статья 4", article_5: "статья 5", nato_reinforcement: "усиление НАТО",
  us_force_posture: "силы США", belarus_russia_integration: "Беларусь—Россия", civil_defence: "гражданская оборона",
  evacuation_preparation: "подготовка к эвакуации", military_readiness: "боеготовность", defence_policy: "оборонная политика",
  diplomatic_escalation: "дипломатическая эскалация", diplomatic_deescalation: "деэскалация", information_operation: "информоперация",
  negative_evidence: "опровержение / нет признаков", other: "прочее",
};

export const TIER_RU: Record<string, string> = {
  A: "официальный источник", B: "информагентство", C: "международные СМИ", D: "региональные СМИ",
  E: "аналитический центр", F: "OSINT", G: "соцсети", S: "госСМИ стороны",
};
