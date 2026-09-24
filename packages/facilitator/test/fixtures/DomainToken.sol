// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DomainToken
/// @notice Test-only fixture exposing `name()` and `version()` as on-chain,
///         queryable view functions -- exactly the two fields (together with
///         `chainid` and the contract's own address) a facilitator's
///         `/verify` must read from the token contract to build the correct
///         EIP-712 domain, per Task 7's spec ("the EIP-712 domain must be
///         read from the token contract on-chain ... not hardcoded").
///
///         Deliberately uses a NON-standard name/version pair (neither the
///         real "USD Coin"/"2" Base mainnet domain, nor a common guess like
///         version "1"). If a verifier under test hardcoded either field
///         instead of reading it from chain, every signature test against
///         this fixture would fail to recover the correct signer -- that
///         mismatch is the whole point of using an unusual pair here.
contract DomainToken {
    string public name;
    string public version;

    constructor(string memory name_, string memory version_) {
        name = name_;
        version = version_;
    }
}
