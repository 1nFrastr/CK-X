/**
 * Tests for practice-mode single-question checks.
 * Run from facilitator/: node --test tests/checkQuestion.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const sshService = require('../src/services/sshService');
const redisClient = require('../src/utils/redisClient');
const jumphostService = require('../src/services/jumphostService');
const examService = require('../src/services/examService');

const sampleQuestion = {
  id: '1',
  namespace: 'dev',
  question: 'Create a deployment',
  concepts: ['deployments'],
  verification: [
    {
      id: '1',
      description: 'Namespace is created',
      verificationScriptFile: 'q1_s1_validate_namespace.sh',
      weightage: '1'
    },
    {
      id: '2',
      description: 'Deployment is created',
      verificationScriptFile: 'q1_s2_validate_deployment.sh',
      weightage: 2
    }
  ]
};

describe('checkQuestionOnJumphost', () => {
  let originalExecuteCommand;
  let originalUpdateExamStatus;
  let originalPersistExamResult;

  beforeEach(() => {
    originalExecuteCommand = sshService.executeCommand;
    originalUpdateExamStatus = redisClient.updateExamStatus;
    originalPersistExamResult = redisClient.persistExamResult;
    redisClient.updateExamStatus = async () => {
      throw new Error('exam status must not change during a practice check');
    };
    redisClient.persistExamResult = async () => {
      throw new Error('exam result must not be persisted during a practice check');
    };
  });

  afterEach(() => {
    sshService.executeCommand = originalExecuteCommand;
    redisClient.updateExamStatus = originalUpdateExamStatus;
    redisClient.persistExamResult = originalPersistExamResult;
  });

  it('returns a passing result when all verification scripts succeed', async () => {
    const commands = [];
    sshService.executeCommand = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const result = await jumphostService.checkQuestionOnJumphost('exam-1', sampleQuestion);

    assert.equal(result.success, true);
    assert.equal(result.data.passed, true);
    assert.equal(result.data.score, 3);
    assert.equal(result.data.totalPossibleScore, 3);
    assert.equal(result.data.questionId, '1');
    assert.equal(result.data.verificationResults.length, 2);
    assert.equal(result.data.verificationResults[0].validAnswer, true);
    assert.equal(commands.length, 2);
    assert.match(commands[0], /q1_s1_validate_namespace\.sh/);
    assert.match(commands[1], /q1_s2_validate_deployment\.sh/);
  });

  it('returns a partial score when some verification scripts fail', async () => {
    sshService.executeCommand = async (command) => {
      if (command.includes('q1_s1_validate_namespace.sh')) {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'missing deployment' };
    };

    const result = await jumphostService.checkQuestionOnJumphost('exam-1', sampleQuestion);

    assert.equal(result.success, true);
    assert.equal(result.data.passed, false);
    assert.equal(result.data.score, 1);
    assert.equal(result.data.totalPossibleScore, 3);
    assert.equal(result.data.verificationResults[0].validAnswer, true);
    assert.equal(result.data.verificationResults[1].validAnswer, false);
    assert.equal(result.data.verificationResults[1].score, 0);
  });

  it('treats a thrown verification as a failed step and continues', async () => {
    sshService.executeCommand = async (command) => {
      if (command.includes('q1_s1_validate_namespace.sh')) {
        throw new Error('ssh timeout');
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const result = await jumphostService.checkQuestionOnJumphost('exam-1', sampleQuestion);

    assert.equal(result.success, true);
    assert.equal(result.data.passed, false);
    assert.equal(result.data.score, 2);
    assert.equal(result.data.verificationResults[0].validAnswer, false);
    assert.equal(result.data.verificationResults[1].validAnswer, true);
  });

  it('handles a question with no verification steps', async () => {
    sshService.executeCommand = async () => {
      throw new Error('should not run any scripts');
    };

    const result = await jumphostService.checkQuestionOnJumphost('exam-1', {
      id: '9',
      namespace: 'dev',
      question: 'No checks',
      verification: []
    });

    assert.equal(result.success, true);
    assert.equal(result.data.passed, false);
    assert.equal(result.data.score, 0);
    assert.equal(result.data.totalPossibleScore, 0);
    assert.deepEqual(result.data.verificationResults, []);
  });
});

describe('examService.checkQuestion', () => {
  let originalGetExamInfo;
  let originalGetExamStatus;
  let originalCheckQuestionOnJumphost;

  beforeEach(() => {
    originalGetExamInfo = redisClient.getExamInfo;
    originalGetExamStatus = redisClient.getExamStatus;
    originalCheckQuestionOnJumphost = jumphostService.checkQuestionOnJumphost;
  });

  afterEach(() => {
    redisClient.getExamInfo = originalGetExamInfo;
    redisClient.getExamStatus = originalGetExamStatus;
    jumphostService.checkQuestionOnJumphost = originalCheckQuestionOnJumphost;
  });

  it('returns 404 when the exam does not exist', async () => {
    redisClient.getExamInfo = async () => null;
    redisClient.getExamStatus = async () => null;

    const result = await examService.checkQuestion('missing', '1');

    assert.equal(result.success, false);
    assert.equal(result.error, 'Not Found');
    assert.equal(result.statusCode, 404);
  });

  it('returns 409 when a full evaluation is already running', async () => {
    redisClient.getExamInfo = async () => ({ assetPath: 'assets/exams/ckad/001' });
    redisClient.getExamStatus = async () => 'EVALUATING';

    const result = await examService.checkQuestion('exam-1', '1');

    assert.equal(result.success, false);
    assert.equal(result.error, 'Conflict');
    assert.equal(result.statusCode, 409);
  });

  it('returns 409 when the environment is not ready', async () => {
    redisClient.getExamInfo = async () => ({ assetPath: 'assets/exams/ckad/001' });
    redisClient.getExamStatus = async () => 'PREPARING';

    const result = await examService.checkQuestion('exam-1', '1');

    assert.equal(result.success, false);
    assert.equal(result.statusCode, 409);
  });

  it('returns 404 when the question does not exist', async () => {
    redisClient.getExamInfo = async () => ({ assetPath: 'assets/exams/ckad/001' });
    redisClient.getExamStatus = async () => 'READY';

    const result = await examService.checkQuestion('exam-1', 'does-not-exist');

    assert.equal(result.success, false);
    assert.equal(result.error, 'Not Found');
    assert.equal(result.statusCode, 404);
  });

  it('delegates a ready exam question to jumphost without changing exam status', async () => {
    redisClient.getExamInfo = async () => ({ assetPath: 'assets/exams/ckad/001' });
    redisClient.getExamStatus = async () => 'READY';
    jumphostService.checkQuestionOnJumphost = async (examId, question) => {
      assert.equal(examId, 'exam-1');
      assert.equal(String(question.id), '1');
      assert.ok(Array.isArray(question.verification));
      return {
        success: true,
        data: {
          examId,
          questionId: '1',
          passed: false,
          score: 1,
          totalPossibleScore: 7,
          verificationResults: []
        }
      };
    };

    const result = await examService.checkQuestion('exam-1', '1');

    assert.equal(result.success, true);
    assert.equal(result.data.questionId, '1');
    assert.equal(result.data.score, 1);
  });
});
