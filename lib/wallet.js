"use strict";

const _ = require('underscore');
const Q = require('q');
const co = require('co');

const IS_PAY_ENABLED = false;
const PAY_VALUE_PER_BLOCK = 10; // The total to pay per chunk, divided by issuers
const BLOCKS_PER_DAY = (60 / 5) * 24;
const BLOCKS_PER_WEEK = (60 / 5) * 24 * 7;

module.exports = (duniterServer) => {

  const remuniterPubkey = duniterServer.PeeringService.pubkey;

  function existsTx(fromBlock, toBlock, txCategory) {
    return co(function *() {
      let txh = yield duniterServer.dal.getTransactionsHistory(remuniterPubkey);
      let txs = _.filter(txh[txCategory], (tx) => {
        let match = tx.comment && tx.comment.match(/^REMU:(\d+):(\d+)$/);
        if (!match) {
          return false;
        }
        let from = parseInt(match[1]);
        let to = parseInt(match[2]);
        return (from <= fromBlock && fromBlock <= to) || (from <= toBlock && toBlock <= to);
      });
      return txs.length > 0;
    });
  }

  function getWhatWasPaid(pubkey, txh, blocks) {
    return txh.sent.reduce((sum, tx) => {
      let match = tx.comment && tx.comment.match(/^REMU:(\d+):(\d+)$/);
      if (!match) {
        return false;
      }
      let from = parseInt(match[1]);
      let to = parseInt(match[2]);
      let nbBlocks = to - from + 1;
      let totalGiven = 0;
      tx.outputs.forEach((out) => {
        let match = out.match(/(\d+):(\d+):SIG\((.*)\)/);
        if (match) {
          let outputAmount = parseInt(match[1]) * Math.pow(10, parseInt(match[2]));
          if (tx.issuers.indexOf(match[3]) === -1) {
            totalGiven += outputAmount;
          }
        }
      });
      let localPayPerBlock = totalGiven / nbBlocks;
      let blocksIssuedInTx = _.filter(blocks, (b) => b.issuer == pubkey && b.number >= from && b.number <= to);
      let paidToPubkey = localPayPerBlock * blocksIssuedInTx.length;
      return sum + paidToPubkey;
    }, 0);
  }

  function getUID(pubkey) {
    return duniterServer.dal.getWrittenIdtyByPubkey(pubkey);
  }

  function getLastX(blocksCount) {
    return co(function *() {
      let current = yield duniterServer.dal.getCurrentBlockOrNull();
      let blocks = yield duniterServer.dal.getBlocksBetween(current.number - blocksCount + 1, current.number);
      let txh = yield duniterServer.dal.getTransactionsHistory(remuniterPubkey);
      let stats = getStatsPerIssuer(blocks);
      let issuers = _.keys(stats);
      for (let i = 0, len = issuers.length; i < len; i++) {
        stats[issuers[i]].idty = yield getUID(issuers[i]);
      }
      return issuers.map((issuer) => {
        return {
          name: stats[issuer].idty.uid,
          blocks: stats[issuer].blocks,
          amount: stats[issuer].amount,
          paid: getWhatWasPaid(issuer, txh, blocks)
        };
      });
    });
  }
  
  return {

    pubkey: remuniterPubkey,

    pay_per_block: PAY_VALUE_PER_BLOCK,

    getUID: getUID,

    remains: () => co(function *() {
      let sources = yield duniterServer.dal.getAvailableSourcesByPubkey(remuniterPubkey);
      return sources.reduce((sum, src) => sum + src.amount * Math.pow(10, src.base), 0);
    }),

    arePaid: (fromBlock, toBlock) => existsTx(fromBlock, toBlock, 'sent'),

    areBeingPaid: (fromBlock, toBlock) => existsTx(fromBlock, toBlock, 'sending'),

    getLastPaid: (fromBlock) => co(function *() {
      let txh = yield duniterServer.dal.getTransactionsHistory(remuniterPubkey);
      let lastTo = 0;
      txh['sent'].forEach((tx) => {
        let match = tx.comment && tx.comment.match(/^REMU:(\d+):(\d+)$/);
        if (!match) {
          return false;
        }
        let to = parseInt(match[2]);
        lastTo = Math.max(0, to);
      });
      return Math.max(fromBlock - 1, lastTo);
    }),

    pay: (fromBlock, toBlock) => co(function *() {
      let blocks = yield duniterServer.dal.getBlocksBetween(fromBlock, toBlock);
      let reallyPaid = PAY_VALUE_PER_BLOCK * blocks.length;
      let statsPerIssuer = getStatsPerIssuer(blocks);
      let base = 0;
      let outputsToIssuers = _.keys(statsPerIssuer).map((issuer) => [statsPerIssuer[issuer].amount, base, 'SIG(' + issuer + ')'].join(':'));
      let sources = yield duniterServer.dal.getAvailableSourcesByPubkey(remuniterPubkey);
      let sourcesTotal = sources.reduce((sum, src) => sum + src.amount * Math.pow(10, src.base), 0);

      if (IS_PAY_ENABLED && sourcesTotal >= reallyPaid) {
        let tx = {
          documentType: 'transaction',
          version: 2,
          currency: duniterServer.conf.currency,
          locktime: 0,
          issuers: [remuniterPubkey],
          inputs: sources.map((src) => [src.type, src.identifier, src.noffset].join(':')),
          unlocks: sources.map((src, index) => [index, 'SIG(0)'].join(':')),
          outputs: outputsToIssuers.concat([sourcesTotal - reallyPaid, base, 'SIG(' + remuniterPubkey + ')'].join(':')),
          comment: ['REMU', fromBlock, toBlock].join(':')
        };
        let rawTX = getRawTransaction(tx);

        // ----- SIGNATURE -----
        tx.signatures = [yield Q.nfcall(duniterServer.sign, rawTX)];

        // ----- SUBMITTING -----
        yield duniterServer.writeRaw(getRawTransaction(tx), 'transaction');

        return existsTx(fromBlock, toBlock, 'sending');
      }
      return false;
    }),
    
    lastDayTheoretical: () => getLastX(BLOCKS_PER_DAY),
    lastWeekTheoretical: () => getLastX(BLOCKS_PER_WEEK)
  }
};

function getStatsPerIssuer(blocks) {
  let amountsPerIssuer = {};
  blocks.forEach((b) => {
    amountsPerIssuer[b.issuer] = amountsPerIssuer[b.issuer] || { amount: 0, blocks: 0, real: 0 };
    amountsPerIssuer[b.issuer].blocks++;
  });
  return amountsPerIssuer;
}

function getRawTransaction(json) {
  let raw = "";
  raw += "Version: " + (json.version) + "\n";
  raw += "Type: Transaction\n";
  raw += "Currency: " + json.currency + "\n";
  raw += "Locktime: " + json.locktime + "\n";
  raw += "Issuers:\n";
  (json.issuers || []).forEach(function (issuer) {
    raw += issuer + '\n';
  });
  raw += "Inputs:\n";
  (json.inputs || []).forEach(function (input) {
    raw += input + '\n';
  });
  raw += "Unlocks:\n";
  (json.unlocks || []).forEach(function (input) {
    raw += input + '\n';
  });
  raw += "Outputs:\n";
  (json.outputs || []).forEach(function (output) {
    raw += output + '\n';
  });
  raw += "Comment: " + (json.comment || "") + "\n";
  (json.signatures || []).forEach(function (signature) {
    raw += signature + '\n';
  });
  return raw;
}