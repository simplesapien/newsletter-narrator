import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import OpenAI from 'openai';
import nodemailer from 'nodemailer';
import dotenv from "dotenv";
import { promises as fsPromises } from 'fs';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import ffmpeg from 'fluent-ffmpeg';

dotenv.config();

const EXCLUDED_SENDERS = ['ByteByteGo', 'HuggingFace'];
const TOPIC_CATEGORIES = [
  'TECH_NEWS',
  'BUSINESS',
  'SECURITY',
  'PRODUCT_UPDATES',
  'INDUSTRY_NEWS',
  'EDUCATIONAL',
  'OTHER'
];

const VOICE_CONFIGS = {
  host: {
    languageCode: 'en-US',
    name: 'en-US-Neural2-D',
    ssmlGender: 'MALE'
  },
  guest: {
    languageCode: 'en-US',
    name: 'en-US-Neural2-F',
    ssmlGender: 'FEMALE'
  }
};

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels'
];

async function getNewToken(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('Authorize this app by visiting this url:', authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise((resolve) => {
    rl.question('Enter the code from that page here: ', (code) => {
      rl.close();
      resolve(code);
    });
  });

  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync('credentials/token.json', JSON.stringify(tokens));
    console.log('Token stored to token.json');
    return tokens;
  } catch (err) {
    console.error('Error retrieving access token', err);
    throw err;
  }
}

async function truncateContent(content, maxTokens = 15000) {
  try {
    const encoding = await import('gpt-tokenizer');
    const tokens = encoding.encode(content);
    if (tokens.length > maxTokens) {
      const truncatedTokens = tokens.slice(0, maxTokens);
      return encoding.decode(truncatedTokens);
    }
    return content;
  } catch (error) {
    console.warn('Token counting failed, falling back to character-based truncation');
    return content.slice(0, maxTokens * 4);
  }
}

class EnhancedNewsletterSummarizer {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.ttsClient = new TextToSpeechClient();

    this.oauth2Client = new OAuth2Client(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'urn:ietf:wg:oauth:2.0:oob'
    );

    this.gmail = null;

    this.mailer = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.SENDER_EMAIL,
        pass: process.env.SENDER_APP_PASSWORD
      }
    });
  }

  async setup() {
    try {
      let tokens;
      try {
        tokens = JSON.parse(await fsPromises.readFile('credentials/token.json'));
      } catch (error) {
        console.log('No existing tokens found or invalid tokens. Getting new tokens...');
        tokens = await getNewToken(this.oauth2Client);
      }

      this.oauth2Client.setCredentials(tokens);

      try {
        this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
        await this.gmail.users.labels.list({ userId: 'me' });
      } catch (error) {
        if (error.message.includes('insufficient_scope') || error.message.includes('invalid_grant')) {
          console.log('Invalid or expired tokens. Getting new tokens...');
          tokens = await getNewToken(this.oauth2Client);
          this.oauth2Client.setCredentials(tokens);
          this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
        } else {
          throw error;
        }
      }

      return true;
    } catch (error) {
      console.error('Error in setup:', error);
      return false;
    }
  }

  async fetchUnreadEmails(maxResults, daysBack) {
    try {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - daysBack);
      const dateQuery = `after:${Math.floor(pastDate.getTime() / 1000)}`;
      
      const query = `is:unread ${dateQuery}`;
      console.log('Search query:', query);
      
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: maxResults,
      });

      const emails = [];
      const messages = response.data.messages || [];
      
      for (const message of messages) {
        const email = await this.gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full',
        });

        const headers = email.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value;
        const from = headers.find(h => h.name === 'From')?.value;
        
        if (EXCLUDED_SENDERS.some(sender => from?.includes(sender))) {
          console.log(`Skipping excluded sender: ${from}`);
          continue;
        }

        let body = await this.extractEmailBody(email.data.payload);

        if (body) {
          emails.push({
            id: message.id,
            subject,
            from,
            body,
            date: new Date(parseInt(email.data.internalDate)),
          });
        }
      }

      return emails;
    } catch (error) {
      console.error('Error fetching emails:', error);
      throw error;
    }
  }

  async extractEmailBody(payload) {
    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          return Buffer.from(part.body.data, 'base64').toString();
        }
      }
    } else if (payload.body.data) {
      return Buffer.from(payload.body.data, 'base64').toString();
    }
    return null;
  }

  async markEmailAsRead(messageId) {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['UNREAD']
        }
      });
      console.log(`Marked email ${messageId} as read`);
    } catch (error) {
      console.error(`Error marking email ${messageId} as read:`, error);
      throw error;
    }
  }

  async summarizeNewsletter(emailContent, source) {
    try {
      const encoding = await import('gpt-tokenizer');
      const tokens = encoding.encode(emailContent);
      const maxTokensPerChunk = 15000;

      if (tokens.length <= maxTokensPerChunk) {
        return await this.processSingleChunk(emailContent);
      }

      console.log(`Content exceeds token limit. Processing in chunks (${tokens.length} tokens)...`);
      let finalSummary = '';
      let currentTopic = '';
      
      for (let i = 0; i < tokens.length; i += maxTokensPerChunk) {
        const chunkTokens = tokens.slice(i, i + maxTokensPerChunk);
        const chunkContent = encoding.decode(chunkTokens);
        const isFirstChunk = i === 0;
        const isLastChunk = i + maxTokensPerChunk >= tokens.length;

        const systemPrompt = isFirstChunk
          ? `Analyze the first part of this newsletter content. Determine the most relevant category from: ${TOPIC_CATEGORIES.join(', ')} and begin summarizing key points. Format as:
             CATEGORY: [chosen category]
             SUMMARY: [your summary]`
          : `Continue analyzing the ${isLastChunk ? 'final' : 'next'} part of the newsletter. Incorporate this into the previous summary. Previous summary context:
             ${finalSummary}`;

        const response = await this.openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: chunkContent
            }
          ],
          temperature: 0.7,
          max_tokens: 750
        });

        const result = response.choices[0].message.content;

        if (isFirstChunk) {
          const categoryMatch = result.match(/CATEGORY:\s*([A-Z_]+)/i);
          currentTopic = categoryMatch ? categoryMatch[1].trim().toUpperCase() : 'OTHER';
          const summaryMatch = result.match(/SUMMARY:\s*([\s\S]+)/i);
          finalSummary = summaryMatch ? summaryMatch[1].trim() : result;
        } else {
          finalSummary = `${finalSummary}\n${result}`;
        }
      }

      return {
        topic: currentTopic,
        summary: finalSummary
      };
    } catch (error) {
      console.error('Error summarizing newsletter:', error);
      throw error;
    }
  }

  async processSingleChunk(content) {
    const response = await this.openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Analyze and summarize the newsletter content. First determine the most relevant category from: ${TOPIC_CATEGORIES.join(', ')}. Then provide a concise summary focusing on key announcements and insights. Format the response as:
          CATEGORY: [chosen category]
          SUMMARY: [your summary]`
        },
        {
          role: "user",
          content
        }
      ],
      temperature: 0.7,
      max_tokens: 750
    });

    const result = response.choices[0].message.content;
    const categoryMatch = result.match(/CATEGORY:\s*([A-Z_]+)/i);
    const summaryMatch = result.match(/SUMMARY:\s*([\s\S]+)/i);

    return {
      topic: categoryMatch ? categoryMatch[1].trim().toUpperCase() : 'OTHER',
      summary: summaryMatch ? summaryMatch[1].trim() : result
    };
  }

  createSpeechScript(summariesByTopic) {
    const timeNow = new Date().toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });
  
    const script = [];
    
    script.push({
      speaker: 'host',
      text: `Welcome to your daily newsletter roundup! It's ${timeNow}, and I'm here with our expert analyst to break down today's key stories.`
    });
    
    script.push({
      speaker: 'guest',
      text: "Thanks for having me! I've reviewed all the newsletters, and we've got some interesting developments to discuss."
    });

    Object.entries(summariesByTopic)
      .filter(([_, summaries]) => summaries.length > 0)
      .forEach(([topic, summaries]) => {
        const topicName = topic.toLowerCase().replace(/_/g, ' ');
        
        script.push({
          speaker: 'host',
          text: `Let's dive into ${topicName}. What are the key updates in this area?`
        });

        summaries.forEach((item, index) => {
          const summaryParts = item.summary.split(/(?<=\.)\s+/);
          
          script.push({
            speaker: 'guest',
            text: `From ${item.from}, we have ${summaryParts[0]}`
          });

          if (summaryParts.length > 1) {
            script.push({
              speaker: 'host',
              text: "That's interesting! What else did they mention?"
            });

            script.push({
              speaker: 'guest',
              text: summaryParts.slice(1).join(' ')
            });
          }

          if (index < summaries.length - 1) {
            script.push({
              speaker: 'host',
              text: "What other updates do we have in this area?"
            });
          }
        });
      });

    script.push({
      speaker: 'host',
      text: "That wraps up our newsletter summary for today. Any final thoughts?"
    });

    script.push({
      speaker: 'guest',
      text: "Thanks for breaking this down with me. Remember to check the email summary for more details on any stories that caught your interest."
    });

    script.push({
      speaker: 'host',
      text: "Thanks for listening, and we'll catch you in the next summary!"
    });

    return script;
  }

  async generateAudioSummary(summariesByTopic) {
    try {
      const speechScript = this.createSpeechScript(summariesByTopic);
      console.log('Generating audio...');

      const audioDir = path.join(process.cwd(), 'audio');
      await fsPromises.mkdir(audioDir, { recursive: true });

      const audioPaths = [];
      
      for (const [index, segment] of speechScript.entries()) {
        console.log(`Processing segment ${index + 1}/${speechScript.length}`);
        
        const voiceConfig = VOICE_CONFIGS[segment.speaker];
        const request = {
          input: { text: segment.text },
          voice: voiceConfig,
          audioConfig: { 
            audioEncoding: 'MP3',
            speakingRate: segment.speaker === 'host' ? 1.1 : 1.0,
            pitch: segment.speaker === 'host' ? 1 : 0.9
          },
        };

        const [response] = await this.ttsClient.synthesizeSpeech(request);
        const segmentPath = path.join(audioDir, `segment_${index}.mp3`);
        await fsPromises.writeFile(segmentPath, response.audioContent, 'binary');
        audioPaths.push(segmentPath);
      }

      const finalAudioPath = path.join(
        audioDir,
        `newsletter-summary-${new Date().toISOString().split('T')[0]}.mp3`
      );

      console.log('Merging audio segments...');
      await new Promise((resolve, reject) => {
        const ffmpegCommand = ffmpeg();

        audioPaths.forEach(audioPath => {
          ffmpegCommand.input(audioPath);
        });

        ffmpegCommand
          .on('end', async () => {
            console.log('Audio merge complete');
            // Clean up segment files
            for (const audioPath of audioPaths) {
              try {
                await fsPromises.unlink(audioPath);
              } catch (err) {
                console.warn(`Warning: Could not delete temporary file ${audioPath}:`, err);
              }
            }
            resolve();
          })
          .on('error', (err) => {
            console.error('Error merging audio files:', err);
            reject(err);
          })
          .complexFilter([{
            filter: 'concat',
            options: {
              n: audioPaths.length,
              v: 0,
              a: 1
            }
          }])
          .save(finalAudioPath);
      });

      console.log(`Final audio saved to: ${finalAudioPath}`);
      return finalAudioPath;

    } catch (error) {
      console.error('Error generating audio summary:', error);
      throw error;
    }
  }

  async sendEnhancedSummaryEmail(summariesByTopic, audioFilePath) {
    try {
      const topicSections = Object.entries(summariesByTopic)
        .filter(([_, summaries]) => summaries.length > 0)
        .map(([topic, summaries]) => `
          <div style="margin-bottom: 40px;">
            <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">
              ${topic.replace(/_/g, ' ')}
            </h2>
            ${summaries.map(item => `
              <div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 8px; background-color: #f9f9f9;">
                <h3 style="color: #2c3e50; margin-bottom: 10px;">${item.subject}</h3>
                <p style="color: #666;"><strong>From:</strong> ${item.from}</p>
                <p style="color: #666;"><strong>Date:</strong> ${item.date.toLocaleString()}</p>
                <div style="margin-top: 15px; line-height: 1.6;">
                  ${item.summary.replace(/\n/g, '<br>')}
                </div>
                <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #ddd;">
                  <a href="https://mail.google.com/mail/u/0/#search/subject:(${encodeURIComponent(item.subject)})" 
                     style="color: #3498db; text-decoration: none;">
                    📧 View Original Email
                  </a>
                </div>
              </div>
            `).join('')}
          </div>
        `).join('');

      const mailOptions = {
        from: `"Newsletter Summarizer" <${process.env.SENDER_EMAIL}>`,
        to: process.env.RECIPIENT_EMAIL,
        subject: `Newsletter Summaries - ${new Date().toLocaleDateString()}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
            <h1 style="color: #2c3e50; text-align: center; margin-bottom: 30px;">
              Your Daily Newsletter Summary
            </h1>
            <div style="text-align: center; margin: 20px 0;">
              <audio controls>
                <source src="cid:summary-audio" type="audio/mpeg">
                Your browser does not support the audio element.
              </audio>
            </div>
            ${topicSections}
          </div>
        `,
        attachments: [{
          filename: 'summary.mp3',
          path: audioFilePath,
          cid: 'summary-audio'
        }]
      };

      await this.mailer.verify();
      const info = await this.mailer.sendMail(mailOptions);
      console.log('Enhanced summary email sent successfully:', info.messageId);
    } catch (error) {
      console.error('Error sending enhanced summary email:', error);
      throw error;
    }
  }
}

async function runEnhancedSummarizer() {
  console.log('🚀 Starting Enhanced Newsletter Summarizer');
  
  try {
    const summarizer = new EnhancedNewsletterSummarizer();
    
    console.log('\nInitializing setup...');
    const setupSuccess = await summarizer.setup();
    if (!setupSuccess) {
      throw new Error('Failed to load authentication tokens');
    }

    console.log('\nFetching unread newsletters...');
    const newsletters = await summarizer.fetchUnreadEmails(10, 7);
    
    if (newsletters.length === 0) {
      console.log('No new newsletters found for processing');
      return;
    }

    console.log('\nProcessing newsletters...');
    const summariesByTopic = {};
    
    TOPIC_CATEGORIES.forEach(topic => {
      summariesByTopic[topic] = [];
    });

    for (const email of newsletters) {
      console.log(`\nProcessing: ${email.subject}`);
      
      const { topic, summary } = await summarizer.summarizeNewsletter(
        email.body,
        email.from
      );
      
      console.log(`Classified as: ${topic}`);
      
      summariesByTopic[topic].push({
        subject: email.subject,
        from: email.from,
        date: email.date,
        summary
      });

      await summarizer.markEmailAsRead(email.id);
    }

    console.log('\nGenerating audio summary...');
    const audioFilePath = await summarizer.generateAudioSummary(summariesByTopic);
    console.log('Audio summary generated:', audioFilePath);

    console.log('\nSending enhanced summary email...');
    await summarizer.sendEnhancedSummaryEmail(summariesByTopic, audioFilePath);

    console.log('\n✅ Enhanced summarization process completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Process failed:', error);
    process.exit(1);
  }
}

// Run the enhanced summarizer
runEnhancedSummarizer();