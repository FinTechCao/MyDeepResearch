import {GoogleGenerativeAI, SchemaType} from "@google/generative-ai";
import dotenv from 'dotenv';
import {ProxyAgent, setGlobalDispatcher} from "undici";
import {readUrl} from "./tools/read";
import fs from 'fs/promises';
import {SafeSearchType, search} from "duck-duck-scrape";
import {rewriteQuery} from "./tools/query-rewriter";
import {dedupQueries} from "./tools/dedup";
import {evaluateAnswer} from "./tools/evaluator";

// Proxy setup remains the same
if (process.env.https_proxy) {
  try {
    const proxyUrl = new URL(process.env.https_proxy).toString();
    const dispatcher = new ProxyAgent({uri: proxyUrl});
    setGlobalDispatcher(dispatcher);
  } catch (error) {
    console.error('Failed to set proxy:', error);
  }
}
dotenv.config();

async function sleep(ms: number) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const startTime = Date.now();
  const endTime = startTime + ms;

  // Clear current line and hide cursor
  process.stdout.write('\x1B[?25l');

  while (Date.now() < endTime) {
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    const frameIndex = Math.floor(Date.now() / 100) % frames.length;

    // Clear line and write new frame
    process.stdout.write(`\r${frames[frameIndex]} Cool down... ${remaining}s remaining`);

    // Small delay for animation
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Clear line, show cursor and move to next line
  process.stdout.write('\r\x1B[K\x1B[?25h\n');

  // Original sleep
  await new Promise(resolve => setTimeout(resolve, 0));
}

type ResponseSchema = {
  type: SchemaType.OBJECT;
  properties: {
    action: {
      type: SchemaType.STRING;
      enum: string[];
      description: string;
    };
    searchQuery: {
      type: SchemaType.STRING;
      description: string;
    };
    URLTargets: {
      type: SchemaType.ARRAY;
      items: {
        type: SchemaType.STRING;
      };
      description: string;
    };
    answer: {
      type: SchemaType.STRING;
      description: string;
    };
    references: {
      type: SchemaType.ARRAY;
      items: {
        type: SchemaType.OBJECT;
        properties: {
          title: {
            type: SchemaType.STRING;
            description: string;
          };
          url: {
            type: SchemaType.STRING;
            description: string;
          };
        };
        required: string[];
      };
      description: string;
    };
    reasoning: {
      type: SchemaType.STRING;
      description: string;
    };
    questionsToAnswer?: {
      type: SchemaType.ARRAY;
      items: {
        type: SchemaType.STRING;
        description: string;
      };
      description: string;
      maxItems: number;
    };
  };
  required: string[];
};

function getSchema(allowReflect: boolean): ResponseSchema {
  return {
    type: SchemaType.OBJECT,
    properties: {
      action: {
        type: SchemaType.STRING,
        enum: allowReflect ? ["search", "deep dive", "answer", "reflect"] : ["search", "deep dive", "answer"],
        description: "Must match exactly one action type"
      },
      questionsToAnswer: allowReflect ? {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.STRING,
          description: "each question must be a single line, concise and clear. not composite or compound, less than 20 words.",
        },
        description: "Only required when choosing 'reflect' action, list of most important questions to answer to fill the knowledge gaps.",
        maxItems: 2
      } : undefined,
      searchQuery: {
        type: SchemaType.STRING,
        description: "Only required when choosing 'search' action, must be a short, keyword-based query that BM25, tf-idf based search engines can understand.",
      },
      URLTargets: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.STRING
        },
        description: "Only required when choosing 'deep dive' action, must be an array of URLs"
      },
      answer: {
        type: SchemaType.STRING,
        description: "Only required when choosing 'answer' action, must be the final answer in natural language"
      },
      references: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            title: {
              type: SchemaType.STRING,
              description: "Title of the document; must be directly from the context",
            },
            url: {
              type: SchemaType.STRING,
              description: "URL of the document; must be directly from the context"
            }
          },
          required: ["title", "url"]
        },
        description: "Only required when choosing 'answer' action, must be an array of references"
      },
      reasoning: {
        type: SchemaType.STRING,
        description: "Explain why choose this action?"
      },
    },
    required: ["action", "reasoning"],
  };
}

function getPrompt(question: string, context?: any[], allQuestions?: string[], allowReflect: boolean = false, badContext?: any[]) {
  const badContextIntro = badContext?.length ?
    `Your last unsuccessful answer contains these previous actions and knowledge:
    ${JSON.stringify(badContext, null, 2)}
    
    Learn to avoid these mistakes and think of a new approach, from a different angle, e.g. search for different keywords, read different URLs, or ask different questions.
    `
    : '';

  const contextIntro = context?.length ?
    `Your current context contains these previous actions and knowledge:
    ${JSON.stringify(context, null, 2)}
    `
    : '';

  let actionsDescription = `
Using your training data and prior lessons learned, answer the following question with absolute certainty:

${question}

When uncertain or needing additional information, select one of these actions:

**search**:
- Query external sources using a public search engine
- Focus on solving one specific aspect of the question
- Only give keywords search query, not full sentences

**deep dive**:
- When you have enough search result and want to deep dive into specific URLs
- It allows you access the full content behind specific URLs

**answer**:
- Provide final response only when 100% certain
- Responses must be definitive (no ambiguity, uncertainty, or disclaimers)
${allowReflect ? `- If doubts remain, use "reflect" instead` : ''}`;

  if (allowReflect) {
    actionsDescription += `\n\n**reflect**:
- Perform critical analysis through hypothetical scenarios or systematic breakdowns
- Identify knowledge gaps and formulate essential clarifying questions
- Questions must be:
  - Original (not variations of existing questions)
  - Focused on single concepts
  - Under 20 words
  - Non-compound/non-complex
${allQuestions?.length ? `Existing questions you have asked, make sure to not repeat them:\n ${allQuestions.join('\n')}` : ''}
  `;
  }

  return `You are an advanced AI research analyst specializing in multi-step reasoning.${contextIntro}${badContextIntro}${actionsDescription}

Respond exclusively in valid JSON format matching exact JSON schema.

Critical Requirements:
- Include ONLY ONE action type
- Never add unsupported keys
- Exclude all non-JSON text, markdown, or explanations
- Maintain strict JSON syntax`;
}

async function getResponse(question: string, tokenBudget: number = 30000000) {
  let totalTokens = 0;
  let context = [];
  let step = 0;
  let gaps: string[] = [question];  // All questions to be answered including the orginal question
  let allQuestions = [question];
  let allKeywords = [];
  let badContext = [];

  while (totalTokens < tokenBudget) {
    // add 1s delay to avoid rate limiting
    await sleep(1000);
    step++;
    console.log('===STEPS===', step)
    console.log('Gaps:', gaps)
    const allowReflect = gaps.length <= 1;
    const currentQuestion = gaps.length > 0 ? gaps.shift()! : question;
    const prompt = getPrompt(currentQuestion, context, allQuestions, allowReflect);
    console.log('Prompt len:', prompt.length)

    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: getSchema(allowReflect)
      }
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const usage = response.usageMetadata;

    totalTokens += usage?.totalTokenCount || 0;
    console.log(`Tokens: ${totalTokens}/${tokenBudget}`);

    const action = JSON.parse(response.text());
    console.log('Question-Action:', currentQuestion, action);

    if (action.action === 'answer') {
      context.push({
        step,
        question: currentQuestion,
        ...action,
      });
      if (currentQuestion === question) {
        const evaluation = await evaluateAnswer(currentQuestion, action.answer);
        if (evaluation) {
          return action;
        } else {
          badContext.push(...context);
          context = [];
        }
      }
    }

    if (action.action === 'reflect' && action.questionsToAnswer) {
      let newGapQuestions = action.questionsToAnswer
      if (allQuestions.length) {
        newGapQuestions = await dedupQueries(newGapQuestions, allQuestions)
      }
      gaps.push(...newGapQuestions);
      allQuestions.push(...newGapQuestions);
      gaps.push(question);  // always keep the original question in the gaps
    }

    // Rest of the action handling remains the same
    try {
      if (action.action === 'search' && action.searchQuery) {
        // rewrite queries
        let keywordsQueries = await rewriteQuery(action.searchQuery);
        // avoid exisitng searched queries
        if (allKeywords.length) {
          keywordsQueries = await dedupQueries(keywordsQueries, allKeywords)
        }
        const searchResults = [];
        for (const query of keywordsQueries) {
          const results = await search(query, {
            safeSearch: SafeSearchType.STRICT
          });
          const minResults = results.results.map(r => ({
            title: r.title,
            url: r.url,
            description: r.description,
          }));
          searchResults.push({query, results: minResults});
          allKeywords.push(query);
          await sleep(5000);
        }

        context.push({
          step,
          question: currentQuestion,
          ...action,
          result: searchResults
        });
      } else if (action.action === 'deep dive' && action.URLTargets?.length) {
        const urlResults = await Promise.all(
          action.URLTargets.map(async (url: string) => {
            const response = await readUrl(url, jinaToken);
            return {url, result: response};
          })
        );
        context.push({
          step,
          question: currentQuestion,
          ...action,
          result: urlResults
        });
        totalTokens += urlResults.reduce((sum, r) => sum + r.result.data.usage.tokens, 0);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    }
    await storeContext(context, allKeywords, allQuestions);
  }
}

async function storeContext(context: any[], keywords: string[], questions: string[]) {
  try {
    await fs.writeFile('context.json', JSON.stringify(context, null, 2));
    await fs.writeFile('keywords.json', JSON.stringify(keywords, null, 2));
    await fs.writeFile('questions.json', JSON.stringify(questions, null, 2));
  } catch (error) {
    console.error('Failed to store context:', error);
  }
}

const apiKey = process.env.GEMINI_API_KEY as string;
const jinaToken = process.env.JINA_API_KEY as string;
if (!apiKey) throw new Error("GEMINI_API_KEY not found");
if (!jinaToken) throw new Error("JINA_API_KEY not found");

const modelName = 'gemini-1.5-flash';
const genAI = new GoogleGenerativeAI(apiKey);

const question = process.argv[2] || "";
getResponse(question);