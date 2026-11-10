import { createHash } from "node:crypto";

/**
 * Feishu interactive-card rendering for dsh's ask_user_question permission
 * requests. The card is intentionally self-contained: every option is a
 * callback button (or a form for multi-select/custom answers), so the whole
 * interaction stays inside the Feishu topic.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionForm {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
}

/** Callback payload carried by a preset-option or skip button. */
export interface QuestionActionPayload {
  requestId: string;
  questionIndex: number;
  optionIndex?: number;
  skip?: boolean;
}

const MAX_BUTTON_TEXT = 100;
const MAX_CARD_MARKDOWN = 4_000;

/** Keep button labels within Feishu's 100-character limit. */
function clipButtonText(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_BUTTON_TEXT ? flat.slice(0, MAX_BUTTON_TEXT - 1) + "…" : flat;
}

/** Keep long question text from exceeding the card payload budget. */
function clipCardMarkdown(value: string): string {
  const text = value.trim();
  return text.length > MAX_CARD_MARKDOWN ? text.slice(0, MAX_CARD_MARKDOWN - 1) + "…" : text;
}

/**
 * Read the synthetic permission request's `input.questions` payload. The dsh
 * connector passes the question headers through as `header`; they are the
 * keys dsh expects back in `updatedInput.answers`, so preserve them verbatim
 * and reproduce its duplicate-header suffixing.
 */
export function parseQuestionForms(input: unknown): QuestionForm[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];

  const usedHeaders = new Set<string>();
  const forms: QuestionForm[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const base =
      typeof record.header === "string" && record.header.trim()
        ? record.header.trim()
        : question.slice(0, 40) || `问题 ${index + 1}`;
    let header = base;
    let suffix = 2;
    while (usedHeaders.has(header)) header = `${base} (${suffix++})`;
    usedHeaders.add(header);

    const options: QuestionOption[] = [];
    if (Array.isArray(record.options)) {
      for (let optionIndex = 0; optionIndex < record.options.length; optionIndex += 1) {
        const option = record.options[optionIndex];
        if (!option || typeof option !== "object" || Array.isArray(option)) continue;
        const entry = option as Record<string, unknown>;
        const label =
          typeof entry.label === "string" && entry.label.trim()
            ? entry.label.trim()
            : `选项 ${optionIndex + 1}`;
        const description =
          typeof entry.description === "string" && entry.description.trim()
            ? entry.description.trim()
            : undefined;
        options.push({ label, ...(description ? { description } : {}) });
      }
    }

    forms.push({
      header,
      question,
      options,
      multiSelect: record.multiSelect === true,
      allowOther: record.allowOther === true,
      allowEmpty: record.allowEmpty === true || options.length === 0,
    });
  }
  return forms;
}

/** Parse a button callback value emitted by a question card. */
export function parseQuestionAction(value: string | undefined): QuestionActionPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.requestId !== "string" || !parsed.requestId) return null;
    const questionIndex = Number(parsed.questionIndex);
    if (!Number.isInteger(questionIndex) || questionIndex < 0) return null;
    const payload: QuestionActionPayload = {
      requestId: parsed.requestId,
      questionIndex,
    };
    const optionIndex = Number(parsed.optionIndex);
    if (Number.isInteger(optionIndex) && optionIndex >= 0) payload.optionIndex = optionIndex;
    if (parsed.skip === true) payload.skip = true;
    return payload;
  } catch {
    return null;
  }
}

/** Stable short token used in form submit names to find the pending request. */
export function questionCardToken(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 8);
}

/**
 * Decode a form submit button's `name`. Forms do not carry a callback value
 * (Feishu replaces it with form_value), so the request token rides along in
 * the button name.
 */
export function parseFormActionName(
  actionName: string | undefined,
): { questionIndex: number; token: string | null } | null {
  if (!actionName) return null;
  const match = /^submit_(?:other|multi)_(\d+)(?:_([a-f0-9]{8}))?$/.exec(actionName);
  if (!match?.[1]) return null;
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 0) return null;
  return { questionIndex: index, token: match[2] ?? null };
}

/**
 * Map a form submission to the answer string dsh expects. The form fields are
 * named `q<questionIndex>_opt<optionIndex>` (checkers, multi-select) and
 * `q<questionIndex>_other` (free text). Returns null when the submission
 * carries no usable answer.
 */
export function parseFormAnswer(
  question: QuestionForm,
  questionIndex: number,
  formValue: string | undefined,
): string | null {
  if (!formValue) return null;
  try {
    const form = JSON.parse(formValue) as Record<string, unknown>;
    if (question.multiSelect) {
      const selected = question.options.filter(
        (_option, optionIndex) => {
          const checked = form[`q${questionIndex}_opt${optionIndex}`];
          return checked === true || checked === "true";
        },
      );
      const custom =
        typeof form[`q${questionIndex}_other`] === "string"
          ? String(form[`q${questionIndex}_other`]).trim()
          : "";
      const labels = selected.map((option) => option.label);
      if (custom) labels.push(custom);
      if (labels.length === 0) return question.allowEmpty ? "" : null;
      // dsh splits multi-select labels on ", " and treats the remainder as
      // custom text; joining with ", " preserves that contract.
      return labels.join(", ");
    }
    const custom =
      typeof form[`q${questionIndex}_other`] === "string"
        ? String(form[`q${questionIndex}_other`]).trim()
        : "";
    if (custom) return custom;
    return question.allowEmpty ? "" : null;
  } catch {
    return null;
  }
}

function optionText(option: QuestionOption): string {
  return option.description ? `${option.label} — ${option.description}` : option.label;
}

function singleSelectButtons(
  requestId: string,
  question: QuestionForm,
  questionIndex: number,
): Record<string, unknown>[] {
  const buttons: Record<string, unknown>[] = question.options.map((option, optionIndex) => ({
    tag: "button",
    text: { tag: "plain_text", content: clipButtonText(optionText(option)) },
    type: optionIndex === 0 ? "primary" : "default",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: {
          requestId,
          questionIndex,
          optionIndex,
        } satisfies QuestionActionPayload,
      },
    ],
  }));
  if (question.allowEmpty || question.options.length === 0) {
    buttons.push({
      tag: "button",
      text: { tag: "plain_text", content: "跳过" },
      type: "default",
      width: "fill",
      behaviors: [
        {
          type: "callback",
          value: { requestId, questionIndex, skip: true } satisfies QuestionActionPayload,
        },
      ],
    });
  }
  return buttons;
}

function otherAnswerForm(questionIndex: number, token: string): Record<string, unknown> {
  return {
    tag: "form",
    name: `other_${questionIndex}_${token}`,
    elements: [
      {
        tag: "input",
        name: `q${questionIndex}_other`,
        required: true,
        placeholder: { tag: "plain_text", content: "其他答案…" },
        label: { tag: "plain_text", content: "其他" },
        max_length: 1_000,
      },
      {
        tag: "button",
        name: `submit_other_${questionIndex}_${token}`,
        text: { tag: "plain_text", content: "提交其他答案" },
        type: "default",
        form_action_type: "submit",
      },
    ],
  };
}

function multiSelectForm(
  question: QuestionForm,
  questionIndex: number,
  token: string,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = question.options.map((option, optionIndex) => ({
    tag: "checker",
    name: `q${questionIndex}_opt${optionIndex}`,
    checked: false,
    text: { tag: "plain_text", content: clipButtonText(optionText(option)) },
  }));
  if (question.allowOther) {
    elements.push({
      tag: "input",
      name: `q${questionIndex}_other`,
      placeholder: { tag: "plain_text", content: "其他答案…" },
      label: { tag: "plain_text", content: "其他" },
      max_length: 1_000,
    });
  }
  elements.push({
    tag: "button",
    name: `submit_multi_${questionIndex}_${token}`,
    text: { tag: "plain_text", content: "提交选择" },
    type: "primary_filled",
    form_action_type: "submit",
  });
  return {
    tag: "form",
    name: `multi_${questionIndex}_${token}`,
    elements,
  };
}

/**
 * Build a Card 2.0 question form. Option buttons and the multi-select/other
 * forms are root body elements because Feishu only allows `form` at that
 * level.
 */
export function buildQuestionCard(options: {
  requestId: string;
  token: string;
  title: string;
  questions: QuestionForm[];
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];
  options.questions.forEach((question, index) => {
    if (index > 0) elements.push({ tag: "hr" });
    const heading = question.header || `问题 ${index + 1}`;
    const prompt = question.question || heading;
    elements.push({
      tag: "markdown",
      content: clipCardMarkdown(`**${index + 1}. ${heading}**\n${prompt}`),
    });
    if (question.multiSelect) {
      elements.push(multiSelectForm(question, index, options.token));
      return;
    }
    elements.push(...singleSelectButtons(options.requestId, question, index));
    if (question.allowOther) elements.push(otherAnswerForm(index, options.token));
  });
  elements.push({
    tag: "markdown",
    content: "点击选项即提交；多选问题勾选后点「提交选择」。也可以在 Paseo 客户端处理。",
  });

  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: clipButtonText(options.title || "需要你选择") },
      template: "blue",
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      elements,
    },
  };
}
