import { Block } from "@ethereumjs/block";
import Common from "@ethereumjs/common";
import { TxData, TypedTransaction } from "@ethereumjs/tx";
import VM from "@ethereumjs/vm";
import { AfterBlockEvent, RunBlockOpts } from "@ethereumjs/vm/dist/runBlock";
import { assert } from "chai";
import { Address, BN, bufferToHex, toBuffer } from "ethereumjs-util";
import { ethers } from "ethers";
import sinon from "sinon";

import { rpcToBlockData } from "../../../../src/internal/hardhat-network/provider/fork/rpcToBlockData";
import { HardhatNode } from "../../../../src/internal/hardhat-network/provider/node";
import {
  ForkedNodeConfig,
  NodeConfig,
  RunCallResult,
} from "../../../../src/internal/hardhat-network/provider/node-types";
import { FakeSenderTransaction } from "../../../../src/internal/hardhat-network/provider/transactions/FakeSenderTransaction";
import { getCurrentTimestamp } from "../../../../src/internal/hardhat-network/provider/utils/getCurrentTimestamp";
import { makeForkClient } from "../../../../src/internal/hardhat-network/provider/utils/makeForkClient";
import { ALCHEMY_URL } from "../../../setup";
import { assertQuantity } from "../helpers/assertions";
import {
  EMPTY_ACCOUNT_ADDRESS,
  FORK_TESTS_CACHE_PATH,
} from "../helpers/constants";
import { expectErrorAsync } from "../../../helpers/errors";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNTS_ADDRESSES,
  DEFAULT_BLOCK_GAS_LIMIT,
  DEFAULT_CHAIN_ID,
  DEFAULT_HARDFORK,
  DEFAULT_NETWORK_ID,
  DEFAULT_NETWORK_NAME,
} from "../helpers/providers";

import { assertEqualBlocks } from "./utils/assertEqualBlocks";

/* eslint-disable @typescript-eslint/dot-notation */

interface ForkedBlock {
  networkName: string;
  url: string;
  blockToRun: number;
  chainId: number;
}

describe("HardhatNode", () => {
  const config: NodeConfig = {
    automine: false,
    hardfork: DEFAULT_HARDFORK,
    networkName: DEFAULT_NETWORK_NAME,
    chainId: DEFAULT_CHAIN_ID,
    networkId: DEFAULT_NETWORK_ID,
    blockGasLimit: DEFAULT_BLOCK_GAS_LIMIT,
    minGasPrice: new BN(0),
    genesisAccounts: DEFAULT_ACCOUNTS,
    initialBaseFeePerGas: 10,
  };
  const gasPrice = 20;
  let node: HardhatNode;
  let createTestTransaction: (
    txData: TxData & { from: string }
  ) => FakeSenderTransaction;

  beforeEach(async () => {
    [, node] = await HardhatNode.create(config);
    createTestTransaction = (txData) => {
      const tx = new FakeSenderTransaction(Address.fromString(txData.from), {
        gasPrice,
        ...txData,
      });
      tx.hash();
      return tx;
    };
  });

  describe("getPendingTransactions", () => {
    it("returns both pending and queued transactions from TxPool", async () => {
      const tx1 = createTestTransaction({
        nonce: 0,
        from: DEFAULT_ACCOUNTS_ADDRESSES[0],
        to: EMPTY_ACCOUNT_ADDRESS,
        gasLimit: 21_000,
      });
      const tx2 = createTestTransaction({
        nonce: 2,
        from: DEFAULT_ACCOUNTS_ADDRESSES[0],
        to: EMPTY_ACCOUNT_ADDRESS,
        gasLimit: 21_000,
      });
      const tx3 = createTestTransaction({
        nonce: 3,
        from: DEFAULT_ACCOUNTS_ADDRESSES[0],
        to: EMPTY_ACCOUNT_ADDRESS,
        gasLimit: 21_000,
      });

      await node.sendTransaction(tx1);
      await node.sendTransaction(tx2);
      await node.sendTransaction(tx3);

      const nodePendingTxs = await node.getPendingTransactions();

      assert.sameDeepMembers(
        nodePendingTxs.map((tx) => tx.raw),
        [tx1, tx2, tx3].map((tx) => tx.raw)
      );
    });
  });

  describe("mineBlock", () => {
    async function assertTransactionsWereMined(txs: TypedTransaction[]) {
      for (const tx of txs) {
        const txReceipt = await node.getTransactionReceipt(tx.hash());
        assert.isDefined(txReceipt);
      }

      const block = await node.getLatestBlock();
      assert.lengthOf(block.transactions, txs.length);
      assert.deepEqual(
        block.transactions.map((tx) => bufferToHex(tx.hash())),
        txs.map((tx) => bufferToHex(tx.hash()))
      );
    }

    describe("basic tests", () => {
      it("can mine an empty block", async () => {
        const beforeBlock = await node.getLatestBlockNumber();
        await node.mineBlock();
        const currentBlock = await node.getLatestBlockNumber();
        assert.equal(currentBlock.toString(), beforeBlock.addn(1).toString());
      });

      it("can mine a block with one transaction", async () => {
        const tx = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx);
        await node.mineBlock();

        await assertTransactionsWereMined([tx]);
        const balance = await node.getAccountBalance(EMPTY_ACCOUNT_ADDRESS);
        assert.equal(balance.toString(), "1234");
      });

      it("can mine a block with two transactions from different senders", async () => {
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        const tx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx2]);
        const balance = await node.getAccountBalance(EMPTY_ACCOUNT_ADDRESS);
        assert.equal(balance.toString(), "2468");
      });

      it("can mine a block with two transactions from the same sender", async () => {
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx2]);
        const balance = await node.getAccountBalance(EMPTY_ACCOUNT_ADDRESS);
        assert.equal(balance.toString(), "2468");
      });

      it("removes the mined transaction from the tx pool", async () => {
        const tx = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx);

        const pendingTransactionsBefore = await node.getPendingTransactions();
        assert.lengthOf(pendingTransactionsBefore, 1);

        await node.mineBlock();

        const pendingTransactionsAfter = await node.getPendingTransactions();
        assert.lengthOf(pendingTransactionsAfter, 0);
      });

      it("leaves the transactions in the tx pool that did not fit in a block", async () => {
        await node.setBlockGasLimit(55_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        const expensiveTx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 40_000,
        });
        const tx3 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(expensiveTx2);
        await node.sendTransaction(tx3);

        const pendingTransactionsBefore = await node.getPendingTransactions();
        assert.sameDeepMembers(
          pendingTransactionsBefore.map((tx) => tx.raw),
          [tx1, expensiveTx2, tx3].map((tx) => tx.raw)
        );

        await node.mineBlock();
        await assertTransactionsWereMined([tx1, tx3]);

        const pendingTransactionsAfter = await node.getPendingTransactions();
        assert.sameDeepMembers(
          pendingTransactionsAfter.map((tx) => tx.raw),
          [expensiveTx2.raw]
        );
      });

      it("sets correct gasUsed values", async () => {
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 100_000,
          value: 1234,
        });
        const tx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 100_000,
          value: 1234,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        const tx1Receipt = await node.getTransactionReceipt(tx1.hash());
        const tx2Receipt = await node.getTransactionReceipt(tx2.hash());
        assertQuantity(tx1Receipt?.gasUsed, 21_000);
        assertQuantity(tx2Receipt?.gasUsed, 21_000);

        const block = await node.getLatestBlock();
        assert.equal(block.header.gasUsed.toNumber(), 42_000);
      });

      it("assigns miner rewards", async () => {
        const gasPriceBN = new BN(1);

        let baseFeePerGas = new BN(0);
        const pendingBlock = await node.getBlockByNumber("pending");
        if (pendingBlock.header.baseFeePerGas !== undefined) {
          baseFeePerGas = pendingBlock.header.baseFeePerGas;
        }

        const miner = node.getCoinbaseAddress();
        const initialMinerBalance = await node.getAccountBalance(miner);

        const oneEther = new BN(10).pow(new BN(18));
        const txFee = gasPriceBN.add(baseFeePerGas).muln(21_000);
        const burnedTxFee = baseFeePerGas.muln(21_000);

        // the miner reward is 2 ETH plus the tx fee, minus the part
        // of the fee that is burned
        const minerReward = oneEther.muln(2).add(txFee).sub(burnedTxFee);

        const tx = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasPrice: gasPriceBN.add(baseFeePerGas),
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx);
        await node.mineBlock();

        const minerBalance = await node.getAccountBalance(miner);
        assert.equal(
          minerBalance.toString(),
          initialMinerBalance.add(minerReward).toString()
        );
      });
    });

    describe("gas limit tests", () => {
      it("mines only as many transactions as would fit in a block", async () => {
        await node.setBlockGasLimit(30_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1]);
        assert.isUndefined(await node.getTransactionReceipt(tx2.hash()));
      });

      it("uses gasLimit value for determining if a new transaction will fit in a block (1 fits)", async () => {
        await node.setBlockGasLimit(50_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1]);
        assert.isUndefined(await node.getTransactionReceipt(tx2.hash()));
      });

      it("uses gasLimit value for determining if a new transaction will fit in a block (2 fit)", async () => {
        // here the first tx is added, and it uses 21_000 gas
        // this leaves 31_000 of gas in the block, so the second one is also included
        await node.setBlockGasLimit(52_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx2]);
      });

      it("uses the rest of the txs when one is dropped because of its gas limit", async () => {
        await node.setBlockGasLimit(50_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
          gasPrice: 40,
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
          gasPrice: 40,
        });
        const tx3 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          gasPrice: 20,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.sendTransaction(tx3);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx3]);
        assert.isUndefined(await node.getTransactionReceipt(tx2.hash()));
      });
    });

    describe("timestamp tests", () => {
      let clock: sinon.SinonFakeTimers;

      beforeEach(() => {
        clock = sinon.useFakeTimers(Date.now());
      });

      afterEach(() => {
        clock.restore();
      });

      it("mines a block with the current timestamp", async () => {
        clock.tick(15_000);
        const now = getCurrentTimestamp();

        await node.mineBlock();
        const block = await node.getLatestBlock();

        assert.equal(block.header.timestamp.toNumber(), now);
      });

      it("mines a block with an incremented timestamp if it clashes with the previous block", async () => {
        const firstBlock = await node.getLatestBlock();
        const firstBlockTimestamp = firstBlock.header.timestamp.toNumber();

        await node.mineBlock();
        const latestBlock = await node.getLatestBlock();
        const latestBlockTimestamp = latestBlock.header.timestamp.toNumber();

        assert.equal(latestBlockTimestamp, firstBlockTimestamp + 1);
      });

      it("assigns an incremented timestamp to each new block mined within the same second", async () => {
        const firstBlock = await node.getLatestBlock();
        const firstBlockTimestamp = firstBlock.header.timestamp.toNumber();

        await node.mineBlock();
        const secondBlock = await node.getLatestBlock();
        const secondBlockTimestamp = secondBlock.header.timestamp.toNumber();

        await node.mineBlock();
        const thirdBlock = await node.getLatestBlock();
        const thirdBlockTimestamp = thirdBlock.header.timestamp.toNumber();

        assert.equal(secondBlockTimestamp, firstBlockTimestamp + 1);
        assert.equal(thirdBlockTimestamp, secondBlockTimestamp + 1);
      });

      it("mines a block with a preset timestamp", async () => {
        const now = getCurrentTimestamp();
        const timestamp = new BN(now).addn(30);
        node.setNextBlockTimestamp(timestamp);
        await node.mineBlock();

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp.toNumber();
        assert.equal(blockTimestamp, timestamp.toNumber());
      });

      it("mines the next block normally after a block with preset timestamp", async () => {
        const now = getCurrentTimestamp();
        const timestamp = new BN(now).addn(30);
        node.setNextBlockTimestamp(timestamp);
        await node.mineBlock();

        clock.tick(3_000);
        await node.mineBlock();

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp.toNumber();
        assert.equal(blockTimestamp, timestamp.toNumber() + 3);
      });

      it("mines a block with the timestamp passed as a parameter irrespective of the preset timestamp", async () => {
        const now = getCurrentTimestamp();
        const presetTimestamp = new BN(now).addn(30);
        node.setNextBlockTimestamp(presetTimestamp);
        const timestamp = new BN(now).addn(60);
        await node.mineBlock(timestamp);

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp.toNumber();
        assert.equal(blockTimestamp, timestamp.toNumber());
      });

      it("mines a block with correct timestamp after time increase", async () => {
        const now = getCurrentTimestamp();
        node.increaseTime(new BN(30));
        await node.mineBlock();

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp.toNumber();
        assert.equal(blockTimestamp, now + 30);
      });

      describe("when time is increased by 30s", () => {
        function testPresetTimestamp(offset: number) {
          it("mines a block with the preset timestamp", async () => {
            const now = getCurrentTimestamp();
            const timestamp = new BN(now).addn(offset);
            node.increaseTime(new BN(30));
            node.setNextBlockTimestamp(timestamp);
            await node.mineBlock();

            const block = await node.getLatestBlock();
            const blockTimestamp = block.header.timestamp.toNumber();
            assert.equal(blockTimestamp, timestamp.toNumber());
          });

          it("mining a block with a preset timestamp changes the time offset", async () => {
            const now = getCurrentTimestamp();
            const timestamp = new BN(now).addn(offset);
            node.increaseTime(new BN(30));
            node.setNextBlockTimestamp(timestamp);
            await node.mineBlock();

            clock.tick(3_000);
            await node.mineBlock();

            const block = await node.getLatestBlock();
            const blockTimestamp = block.header.timestamp.toNumber();
            assert.equal(blockTimestamp, timestamp.toNumber() + 3);
          });
        }

        describe("when preset timestamp is 20s into the future", () => {
          testPresetTimestamp(20);
        });

        describe("when preset timestamp is 40s into the future", () => {
          testPresetTimestamp(40);
        });
      });
    });
  });

  describe("full block", function () {
    if (ALCHEMY_URL === undefined) {
      return;
    }

    const forkedBlocks: ForkedBlock[] = [
      // We don't run this test against spurious dragon because
      // its receipts contain the state root, and we can't compute it
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 4370001,
        chainId: 1,
      },
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 7280001,
        chainId: 1,
      },
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 9069001,
        chainId: 1,
      },
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 9300077,
        chainId: 1,
      },
      {
        networkName: "kovan",
        url: ALCHEMY_URL.replace("mainnet", "kovan"),
        blockToRun: 23115227,
        chainId: 42,
      },
      {
        networkName: "rinkeby",
        url: ALCHEMY_URL.replace("mainnet", "rinkeby"),
        blockToRun: 8004365,
        chainId: 4,
      },
      {
        networkName: "ropsten",
        url: ALCHEMY_URL.replace("mainnet", "ropsten"),
        blockToRun: 9812365, // this block has a EIP-2930 tx
        chainId: 3,
      },
      {
        networkName: "ropsten",
        url: ALCHEMY_URL.replace("mainnet", "ropsten"),
        blockToRun: 10499406, // this block has a EIP-1559 tx
        chainId: 3,
      },
    ];

    for (const { url, blockToRun, networkName, chainId } of forkedBlocks) {
      const remoteCommon = new Common({ chain: chainId });
      const hardfork = remoteCommon.getHardforkByBlockNumber(blockToRun);

      it(`should run a ${networkName} block from ${hardfork} and produce the same results`, async function () {
        this.timeout(120000);

        const forkConfig = {
          jsonRpcUrl: url,
          blockNumber: blockToRun - 1,
        };

        const { forkClient } = await makeForkClient(forkConfig);

        const rpcBlock = await forkClient.getBlockByNumber(
          new BN(blockToRun),
          true
        );

        if (rpcBlock === null) {
          assert.fail();
        }

        const forkedNodeConfig: ForkedNodeConfig = {
          automine: true,
          networkName: "mainnet",
          chainId,
          networkId: 1,
          hardfork,
          forkConfig,
          forkCachePath: FORK_TESTS_CACHE_PATH,
          blockGasLimit: rpcBlock.gasLimit.toNumber(),
          minGasPrice: new BN(0),
          genesisAccounts: [],
        };

        const [common, forkedNode] = await HardhatNode.create(forkedNodeConfig);

        const block = Block.fromBlockData(
          rpcToBlockData({
            ...rpcBlock,
            // We wipe the receipt root to make sure we get a new one
            receiptsRoot: Buffer.alloc(32, 0),
          }),
          {
            common,
            freeze: false,
          }
        );

        forkedNode["_vmTracer"].disableTracing();

        const afterBlockEvent = await runBlockAndGetAfterBlockEvent(
          forkedNode["_vm"],
          {
            block,
            generate: true,
            skipBlockValidation: true,
          }
        );

        const modifiedBlock = afterBlockEvent.block;

        await forkedNode["_vm"].blockchain.putBlock(modifiedBlock);
        await forkedNode["_saveBlockAsSuccessfullyRun"](
          modifiedBlock,
          afterBlockEvent
        );

        const newBlock = await forkedNode.getBlockByNumber(new BN(blockToRun));

        if (newBlock === undefined) {
          assert.fail();
        }

        await assertEqualBlocks(
          newBlock,
          afterBlockEvent,
          rpcBlock,
          forkClient
        );
      });
    }
  });

  it("should run calls in the right hardfork context", async function () {
    // fork mainnet at the block when EIP-1559 activated (12965000), and try to
    // run a call that specifies gas limits in EIP-1559 terms, but run that
    // call one block earlier, and expect that call to fail because it should
    // have specified gas limits in PRE-EIP-1559 terms.

    this.timeout(5000);

    // as a test that does forking, we need a remote Alchemy node to fork from:
    if (ALCHEMY_URL === undefined) {
      return;
    }
    const urlOfNodeToFork = ALCHEMY_URL;

    const eip1559ActivationBlock = 12965000;

    const forkedNodeConfig: ForkedNodeConfig = {
      automine: true,
      networkName: "mainnet",
      chainId: 1,
      networkId: 1,
      hardfork: "london",
      forkConfig: {
        jsonRpcUrl: urlOfNodeToFork,
        blockNumber: eip1559ActivationBlock,
      },
      forkCachePath: FORK_TESTS_CACHE_PATH,
      blockGasLimit: 1_000_000,
      minGasPrice: new BN(0),
      genesisAccounts: [],
    };

    const [, regularNode] = await HardhatNode.create(forkedNodeConfig);

    const nodeCfgWithActivations = forkedNodeConfig;
    nodeCfgWithActivations.forkConfig.hardforkActivationsByChain = {
      1: {
        berlin: eip1559ActivationBlock - 1000,
        london: eip1559ActivationBlock,
      },
    };
    const [, nodeWithHFHist] = await HardhatNode.create(nodeCfgWithActivations);

    /** execute a call to method Hello() on contract HelloWorld, deployed to
     * mainnet years ago, which should return a string, "Hello World". */
    async function runCall(
      gasParams: { gasPrice?: BN; maxFeePerGas?: BN },
      block: number,
      targetNode: HardhatNode = regularNode
    ): Promise<string> {
      const contractInterface = new ethers.utils.Interface(
        JSON.stringify([
          {
            constant: true,
            inputs: [],
            name: "Hello",
            outputs: [{ name: "", type: "string" }],
            payable: false,
            stateMutability: "pure",
            type: "function",
          },
        ])
      );

      const callOpts = {
        to: toBuffer("0xe36613A299bA695aBA8D0c0011FCe95e681f6dD3"),
        from: toBuffer(DEFAULT_ACCOUNTS_ADDRESSES[0]),
        value: new BN(0),
        data: toBuffer(contractInterface.encodeFunctionData("Hello", [])),
        gasLimit: new BN(1_000_000),
      };

      function decodeResult(runCallResult: RunCallResult) {
        return contractInterface.decodeFunctionResult(
          "Hello",
          bufferToHex(runCallResult.result.value)
        )[0];
      }

      return decodeResult(
        await targetNode.runCall({ ...callOpts, ...gasParams }, new BN(block))
      );
    }

    // some shorthand for code below:
    const post1559Block = eip1559ActivationBlock;
    const pre1559Block = eip1559ActivationBlock - 1;
    const pre1559GasOpts = { gasPrice: new BN(0) };
    const post1559GasOpts = { maxFeePerGas: new BN(0) };

    // some sanity checks:
    assert.equal("Hello World", await runCall(post1559GasOpts, post1559Block));
    // we expect this next one to fail, since we're exercising the behavior
    // when you ask for an old block and DON'T supply a hardfork history
    // config, in which case we throw an error.
    await expectErrorAsync(async () => {
      assert.equal("Hello World", await runCall(pre1559GasOpts, pre1559Block));
    }, "No known hardfork for execution on historical block");

    // it("should execute with the constructor-specified hardfork, even for blocks predating that hardfork"
    assert.equal("Hello World", await runCall(post1559GasOpts, pre1559Block));

    // it("should utilize a hardfork history to execute under the HF that was active at the target block"
    await expectErrorAsync(async () => {
      await runCall(post1559GasOpts, pre1559Block, nodeWithHFHist);
    }, "Cannot run transaction: EIP 1559 is not activated.");

    // it("in the presence of a hardfork history, executes under the hardfork that was active at the target block"
    // (same checks as the initial sanity checks, but using the node with a HF
    // history)
    assert.equal(
      "Hello World",
      await runCall(post1559GasOpts, post1559Block, nodeWithHFHist)
    );
    assert.equal(
      "Hello World",
      await runCall(pre1559GasOpts, pre1559Block, nodeWithHFHist)
    );
  });
});

async function runBlockAndGetAfterBlockEvent(
  vm: VM,
  runBlockOpts: RunBlockOpts
): Promise<AfterBlockEvent> {
  let results: AfterBlockEvent;

  function handler(event: AfterBlockEvent) {
    results = event;
  }

  try {
    vm.once("afterBlock", handler);
    await vm.runBlock(runBlockOpts);
  } finally {
    // We need this in case `runBlock` throws before emitting the event.
    // Otherwise we'd be leaking the listener until the next call to runBlock.
    vm.removeListener("afterBlock", handler);
  }

  return results!;
}
