import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQuestionCard,
  buildSubmittedQuestionCard,
  parseFormActionName,
  parseFormAnswer,
  parseQuestionAction,
  parseQuestionForms,
  questionCardToken,
  type QuestionForm,
} from "../server/question-card.ts";

const SAMPLE_INPUT = {
  questions: [
    {
      header: "选择方案",
      question: "选哪个方案？",
      options: [{ label: "方案A" }, { label: "方案B", description: "B 的描述" }],
      multiSelect: false,
      allowOther: true,
      allowEmpty: false,
    },
    {
      question: "多选一下",
      options: [{ label: "X" }, { label: "Y" }],
      multiSelect: true,
      allowOther: true,
      allowEmpty: false,
    },
    {
      header: "选择方案",
      question: "重复 header 要加后缀",
      options: [],
      multiSelect: false,
      allowOther: false,
      allowEmpty: true,
    },
  ],
};

/** Recursively collect every nested card element with the given tag. */
function collectElements(node: unknown, tag: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.tag === tag) found.push(record);
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
  return found;
}

describe("parseQuestionForms", () => {
  it("preserves headers, options, flags and dsh's duplicate suffix", () => {
    const forms = parseQuestionForms(SAMPLE_INPUT);
    assert.equal(forms.length, 3);
    assert.equal(forms[0]?.header, "选择方案");
    assert.deepEqual(forms[0]?.options, [
      { label: "方案A" },
      { label: "方案B", description: "B 的描述" },
    ]);
    assert.equal(forms[0]?.multiSelect, false);
    assert.equal(forms[0]?.allowOther, true);
    assert.equal(forms[1]?.header, "多选一下");
    assert.equal(forms[1]?.multiSelect, true);
    assert.equal(forms[2]?.header, "选择方案 (2)");
    assert.equal(forms[2]?.allowEmpty, true);
  });

  it("returns no forms for malformed payloads", () => {
    assert.deepEqual(parseQuestionForms(null), []);
    assert.deepEqual(parseQuestionForms({}), []);
    assert.deepEqual(parseQuestionForms({ questions: "nope" }), []);
  });
});

describe("buildQuestionCard", () => {
  const forms = parseQuestionForms(SAMPLE_INPUT);
  const token = "abcd1234";
  const card = buildQuestionCard({
    requestId: "permission:paseo-question-q-1",
    token,
    title: "需要你选择",
    questions: forms,
  });

  it("uses Card 2.0 and keeps the request id in option callbacks", () => {
    assert.equal(card.schema, "2.0");
    const body = card.body as { elements: Record<string, unknown>[] };
    assert.ok(body.elements.length > 0);
    const buttons = collectElements(card, "button");
    const first = buttons[0] as {
      behaviors: { value: Record<string, unknown> }[];
    };
    assert.deepEqual(first.behaviors[0]?.value, {
      requestId: "permission:paseo-question-q-1",
      questionIndex: 0,
      optionIndex: 0,
    });
  });

  it("renders option text as wrapping markdown and keeps buttons short", () => {
    const longLabel = "手动调整展示顺序（推荐）";
    const longDescription = "在服务管理里拖动已经上架的商品，自己决定它们展示的先后顺序";
    const longForms = parseQuestionForms({
      questions: [
        {
          header: "确认排序方式",
          question: "具体指哪一种？",
          options: [
            { label: longLabel, description: longDescription },
            { label: "两者都要", description: "既支持手动调整，也支持按价格/销量排序" },
          ],
        },
      ],
    });
    const longCard = buildQuestionCard({
      requestId: "permission:paseo-question-q-long",
      token,
      title: "确认排序方式",
      questions: longForms,
    });
    const markdown = collectElements(longCard, "markdown")
      .map((element) => String(element.content ?? ""))
      .join("\n");
    assert.match(markdown, new RegExp(longLabel));
    assert.match(markdown, new RegExp(longDescription));
    assert.match(markdown, /既支持手动调整/);
    assert.match(markdown, /按价格\/销量排序/);

    const optionButtons = collectElements(longCard, "button");
    assert.deepEqual(
      optionButtons.map((button) => (button.text as { content?: string }).content),
      ["选择", "选择"],
    );
    const firstRow = (longCard.body as { elements: Record<string, unknown>[] }).elements.find(
      (element) => element.tag === "column_set",
    ) as { columns: { weight?: number; elements: { tag: string }[] }[] };
    assert.equal(firstRow.columns.length, 2);
    assert.deepEqual(firstRow.columns.map((column) => column.weight), [4, 1]);
    assert.deepEqual(firstRow.columns.map((column) => column.elements[0]?.tag), [
      "markdown",
      "button",
    ]);
  });

  it("keeps multi-select labels readable next to compact checkers", () => {
    const multiForms = parseQuestionForms({
      questions: [
        {
          header: "多选",
          question: "选哪些？",
          options: [
            { label: "手动调整展示顺序", description: "自己拖动排序" },
            { label: "按价格排序" },
          ],
          multiSelect: true,
          allowOther: false,
          allowEmpty: false,
        },
      ],
    });
    const multiCard = buildQuestionCard({
      requestId: "permission:paseo-question-q-multi-long",
      token,
      title: "多选",
      questions: multiForms,
    });
    const checkers = collectElements(multiCard, "checker");
    assert.equal(checkers.length, 2);
    assert.deepEqual(
      checkers.map((checker) => (checker.text as { content?: string }).content),
      ["选择", "选择"],
    );
    const markdown = collectElements(multiCard, "markdown")
      .map((element) => String(element.content ?? ""))
      .join("\n");
    assert.match(markdown, /手动调整展示顺序/);
    assert.match(markdown, /自己拖动排序/);
    assert.match(markdown, /按价格排序/);
  });

  it("adds the request token to form submit names", () => {
    const body = card.body as { elements: Record<string, unknown>[] };
    const formsInCard = body.elements.filter((element) => element.tag === "form") as {
      name: string;
      elements: { tag: string; name?: string }[];
    }[];
    assert.ok(formsInCard.some((form) => form.name === `other_0_${token}`));
    assert.ok(formsInCard.some((form) => form.name === `multi_1_${token}`));
    const submits = formsInCard.flatMap((form) =>
      collectElements(form, "button").filter((element) => element.name),
    );
    assert.ok(submits.some((button) => button.name === `submit_other_0_${token}`));
    assert.ok(submits.some((button) => button.name === `submit_multi_1_${token}`));
  });

  it("adds a skip button for an empty question", () => {
    const body = card.body as { elements: Record<string, unknown>[] };
    const skipButtons = collectElements(card, "button").filter(
      (element) => (element.text as { content?: string } | undefined)?.content === "跳过",
    );
    assert.equal(skipButtons.length, 1);
  });
});

describe("parseQuestionAction", () => {
  it("parses option and skip payloads", () => {
    assert.deepEqual(parseQuestionAction('{"requestId":"r","questionIndex":1,"optionIndex":2}'), {
      requestId: "r",
      questionIndex: 1,
      optionIndex: 2,
    });
    assert.deepEqual(parseQuestionAction('{"requestId":"r","questionIndex":0,"skip":true}'), {
      requestId: "r",
      questionIndex: 0,
      skip: true,
    });
  });

  it("rejects malformed payloads", () => {
    assert.equal(parseQuestionAction(undefined), null);
    assert.equal(parseQuestionAction("not json"), null);
    assert.equal(parseQuestionAction('{"requestId":"r"}'), null);
    assert.equal(parseQuestionAction('{"questionIndex":0}'), null);
  });
});

describe("parseFormActionName", () => {
  it("reads the question index and optional token", () => {
    assert.deepEqual(parseFormActionName("submit_other_2_abcd1234"), {
      questionIndex: 2,
      token: "abcd1234",
    });
    assert.deepEqual(parseFormActionName("submit_multi_0"), {
      questionIndex: 0,
      token: null,
    });
    assert.equal(parseFormActionName("button_1"), null);
    assert.equal(parseFormActionName(undefined), null);
  });
});

describe("parseFormAnswer", () => {
  const single: QuestionForm = {
    header: "选择方案",
    question: "选哪个方案？",
    options: [{ label: "方案A" }, { label: "方案B" }],
    multiSelect: false,
    allowOther: true,
    allowEmpty: false,
  };
  const multi: QuestionForm = {
    header: "多选",
    question: "选哪些？",
    options: [{ label: "X" }, { label: "Y" }],
    multiSelect: true,
    allowOther: true,
    allowEmpty: false,
  };

  it("returns custom text for a single-select other form", () => {
    assert.equal(parseFormAnswer(single, 0, '{"q0_other":"自定义答案"}'), "自定义答案");
  });

  it("joins checked options and custom text for multi-select", () => {
    assert.equal(
      parseFormAnswer(multi, 1, '{"q1_opt0":true,"q1_opt1":false,"q1_other":"补充"}'),
      "X, 补充",
    );
  });

  it("returns an empty answer only when the question allows empty", () => {
    assert.equal(parseFormAnswer(single, 0, "{}"), null);
    assert.equal(
      parseFormAnswer({ ...single, allowEmpty: true }, 0, "{}"),
      "",
    );
  });

  it("returns null for malformed form values", () => {
    assert.equal(parseFormAnswer(single, 0, "not json"), null);
  });
});

describe("questionCardToken", () => {
  it("is stable and long enough to avoid cross-request collisions", () => {
    const token = questionCardToken("permission:paseo-question-q-1");
    assert.match(token, /^[a-f0-9]{16}$/);
    assert.equal(token, questionCardToken("permission:paseo-question-q-1"));
  });
});


describe("buildSubmittedQuestionCard", () => {
  it("renders the submitted answers and drops all controls", () => {
    const forms = parseQuestionForms(SAMPLE_INPUT);
    const card = buildSubmittedQuestionCard({
      title: "选择方案",
      questions: forms,
      answers: new Map([
        [0, "方案B"],
        [1, "X, 补充"],
      ]),
    });
    const text = JSON.stringify(card);
    assert.equal((card as { schema?: string }).schema, "2.0");
    assert.equal((card as { header?: { template?: string } }).header?.template, "green");
    assert.match(text, /已提交 · 选择方案/);
    assert.match(text, /方案B/);
    assert.match(text, /X, 补充/);
    assert.match(text, /（跳过）/);
    assert.doesNotMatch(text, /"tag":"button"/);
    assert.doesNotMatch(text, /"tag":"form"/);
  });
});
