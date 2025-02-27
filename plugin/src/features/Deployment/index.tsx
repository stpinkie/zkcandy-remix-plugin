/* eslint-disable @typescript-eslint/restrict-plus-operands */
/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import React, { useEffect, useState } from 'react'

import CompiledContracts from '../../components/CompiledContracts'
import './styles.css'
import Container from '../../ui_components/Container'

import { type AccordianTabs } from '../Plugin'
import * as zksync from 'zksync-ethers'
import ConstructorInput from '../../components/ConstructorInput'
import { type VerificationResult, type DeployedContract } from '../../types/contracts'
import { mockManualChain, type Transaction } from '../../types/transaction'
import { type Contract } from 'ethers'
import { useWalletClient } from 'wagmi'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { transactionsAtom } from '../../atoms/transaction'
import { contractsAtom, selectedContractAtom } from '../../atoms/compiledContracts'
import { accountAtom, providerAtom } from '../../atoms/connection'
import { deployedContractsAtom, deployedSelectedContractAtom } from '../../atoms/deployedContracts'
import { envAtom } from '../../atoms/environment'
import { isVerifyingAtom, verificationAtom } from '../../atoms/verification'
import { asyncPost } from '../../api/asyncRequests'
import { solidityVersionAtom } from '../../atoms/version'
import { deployStatusAtom } from '../../atoms/deployment'
import { saveCode } from '../../api/saveCode'
import { remixClientAtom } from '../../stores/remixClient'

interface DeploymentProps {
  setActiveTab: (tab: AccordianTabs) => void
}

const Deployment: React.FC<DeploymentProps> = ({ setActiveTab }) => {
  const { data: walletClient } = useWalletClient()

  const [transactions, setTransactions] = useAtom(transactionsAtom)
  const contracts = useAtomValue(contractsAtom)
  const selectedContract = useAtomValue(selectedContractAtom)
  const account = useAtomValue(accountAtom)
  const [deployedContracts, setDeployedContracts] = useAtom(deployedContractsAtom)
  const setDeployedSelectedContract = useSetAtom(deployedSelectedContractAtom)
  const [inputs, setInputs] = useState<string[]>([])
  const [shouldRunVerification, setShouldRunVerification] = useState<boolean>(false)

  const {
    currentFilename,
    hashDir,
    isValidSolidity,
    isVerifying
  } = useAtomValue(verificationAtom)

  const setStatus = useSetAtom(deployStatusAtom)

  const setIsVerifying = useSetAtom(isVerifyingAtom)

  const [selectedChainName, setSelectedChainName] = React.useState<string | undefined>()

  const solidityVersion = useAtomValue(solidityVersionAtom)
  const env = useAtomValue(envAtom)
  const provider = useAtomValue(providerAtom)

  const remixClient = useAtomValue(remixClientAtom)

  useEffect(() => {
    const constructor = selectedContract?.abi.find((abiElement) => {
      return abiElement.type === 'constructor'
    })

    if (constructor === undefined || constructor?.inputs === undefined) {
      setInputs([])
      return
    }

    setInputs(new Array(constructor?.inputs.length).fill(''))
  }, [selectedContract])

  useEffect(() => {
    let name: string | undefined
    if (provider?.network?.chainId === 300) name = 'sepolia'
    if (provider?.network?.chainId === 324) name = 'mainnet'
    setSelectedChainName(name)
  }, [provider, env])

  async function verify (contract: DeployedContract | null): Promise<void> {
    if (!contract) {
      throw new Error('Not able to retrieve deployed contract for verification')
    }

    setIsVerifying(true)
    setStatus('Verifying...')
    // clear current file annotations: inline syntax error reporting
    await remixClient.editor.clearAnnotations()
    try {
      setStatus('Getting solidity file path...')
      const currentFilePath = await remixClient.call(
        'fileManager',
        'getCurrentFile'
      )

      setStatus('Getting solidity file content...')
      const currentFileContent = await remixClient.call('fileManager', 'readFile', currentFilePath)

      setStatus('Parsing solidity code...')
      await saveCode(solidityVersion, hashDir, currentFilePath, currentFileContent)

      setStatus('Verifying...')

      const chainName = selectedChainName ?? 'unknown'

      const response = await asyncPost(
        `verify-async/${solidityVersion}/${chainName}/${contract.address}/${hashDir}/${currentFilePath}`,
        'verify-result',
        inputs
      )

      if (!response.ok) {
        throw new Error('Could not reach solidity verification server')
      }

      // get Json body from response
      const verificationResult = JSON.parse(await response.text()) as VerificationResult

      if (verificationResult.status !== 'Success') {
        setStatus('Reporting Errors...')
        await remixClient.terminal.log({
          value: verificationResult.message,
          type: 'error'
        })

        const errorLets = verificationResult.message.trim().split('\n')

        // remove last element if it's starts with `Error:`
        if (errorLets[errorLets.length - 1].startsWith('Error:')) {
          errorLets.pop()
        }

        // break the errorLets in array of arrays with first element contains the string `Plugin diagnostic`
        const errorLetsArray = errorLets.reduce(
          (acc: any, curr: any) => {
            if (curr.startsWith('error:') || curr.startsWith('warning:')) {
              acc.push([curr])
            } else {
              acc[acc.length - 1].push(curr)
            }
            return acc
          },
          [['errors diagnostic:']]
        )

        // remove the first array
        errorLetsArray.shift()

        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        errorLetsArray.forEach(async (errorLet: any) => {
          const errorType = errorLet[0].split(':')[0].trim()
          const errorTitle = errorLet[0].split(':').slice(1).join(':').trim()
          const errorLine = errorLet[1].split(':')[1].trim()
          const errorColumn = errorLet[1].split(':')[2].trim()
          // join the rest of the array
          const errorMsg = errorLet.slice(2).join('\n')

          await remixClient.editor.addAnnotation({
            row: Number(errorLine) - 1,
            column: Number(errorColumn) - 1,
            text: errorMsg + '\n' + errorTitle,
            type: errorType
          })
        })

        // trim sierra message to get last line
        const lastLine = verificationResult.message.trim().split('\n').pop()?.trim()

        remixClient.emit('statusChanged', {
          key: 'failed',
          type: 'error',
          title: (lastLine ?? '').startsWith('Error') ? lastLine : 'Verification Failed'
        })
        throw new Error(
          'Solidity Verification Failed, logs can be read in the terminal log'
        )
      } else {
        remixClient.emit('statusChanged', {
          key: 'succeed',
          type: 'success',
          title: 'Verification Successful'
        })

        await remixClient.terminal.log({
          value: 'Verification successful.',
          type: 'info'
        })

        await remixClient.call(
          'notification' as any,
          'toast',
          'Verification successful.'
        )
      }
    } catch (e) {
      setStatus('failed')
      if (e instanceof Error) {
        await remixClient.call('notification' as any, 'alert', {
          id: 'zksyncRemixPluginAlert',
          title: 'Expectation Failed',
          message: e.message
        })
      }
      console.error(e)
    } finally {
      setIsVerifying(false)
    }
  }

  async function deploy (): Promise<void> {
    //   Deploy contract
    if (selectedContract == null) {
      await remixClient.call(
        'notification' as any,
        'toast',
        'No contract selected'
      )

      return
    }

    if (account == null) {
      await remixClient.call(
        'notification' as any,
        'toast',
        'No account selected'
      )

      return
    }

    if (env === 'wallet' && walletClient == null) {
      await remixClient.terminal.log({
        value: 'Wallet is not connected!',
        type: 'error'
      })

      return
    }

    await remixClient.terminal.log({
      value: `Deploying contract ${selectedContract.contractName}`,
      type: 'info'
    })

    const factory = new zksync.ContractFactory(
      selectedContract.abi,
      selectedContract.bytecode,
      account
    )

    try {
      const contract: Contract = await factory.deploy(...inputs)

      remixClient.emit('statusChanged', {
        key: 'loading',
        type: 'info',
        title: `Contract ${selectedContract.contractName} is deploying!`
      })

      const tx = await contract.deployed()

      remixClient.emit('statusChanged', {
        key: 'succeed',
        type: 'success',
        title: `Contract ${selectedContract.contractName} deployed!`
      })

      const address = tx.address
      const txHash = tx.deployTransaction.hash

      const contractOutputTx = tx.deployTransaction

      contractOutputTx.data = contractOutputTx.data.slice(0, contractOutputTx.data.length / 3) + '...'

      // @ts-expect-error: customData is returned properly but the type is not defined
      contractOutputTx.customData.factoryDeps = '[ <...> ]'

      await remixClient.terminal.log({
        value: `${JSON.stringify(contractOutputTx, null, 2)}`,
        type: 'info'
      })

      const deployedContract: DeployedContract = {
        ...selectedContract,
        bytecode: selectedContract.bytecode,
        transactionHash: txHash,
        address,
        env
      }

      setDeployedContracts([deployedContract, ...deployedContracts])
      setDeployedSelectedContract(deployedContract)

      if (shouldRunVerification) {
        await verify(deployedContract)
      }

      setActiveTab('interaction')

      const transaction: Transaction = {
        account,
        type: 'deploy',
        txId: txHash,
        env,
        chain: (env !== 'manual' ? walletClient?.chain : mockManualChain),
        provider
      }

      setTransactions([transaction, ...transactions])
    } catch (e) {
      if (e instanceof Error) {
        await remixClient.terminal.log({
          value: `Error: ${JSON.stringify(e.message)}`,
          type: 'error'
        })
        await remixClient.call(
          'notification' as any,
          'toast',
          `Error: ${JSON.stringify(e.message)}`
        )
      }
      remixClient.emit('statusChanged', {
        key: 'failed',
        type: 'error',
        title: `Contract ${selectedContract.contractName} failed to deploy!`
      })
      console.error(e)
    }
  }

  return (
    <>
      <Container>
        {contracts.length > 0
          ? (
            <div>
              <CompiledContracts show={'contract'}></CompiledContracts>
              {
                (selectedContract != null)
                  ? <div>
                    <ConstructorInput inputs={inputs} setInputs={setInputs}></ConstructorInput>

                    <button
                      className='deploy-btn btn btn-primary btn-warning w-100 text-break mb-1 mt-2 px-0'
                      onClick={() => {
                        deploy().catch((err) => {
                          console.log(err)
                        })
                      }}
                    >
                      Deploy { shouldRunVerification ? ' and Verify' : '' }
                    </button>

                    <input
                      id='shouldRunVerificationChk'
                      name='shouldRunVerificationChk'
                      type='checkbox'
                      checked={shouldRunVerification}
                      onChange={(e) => { setShouldRunVerification(e.target.checked) }}
                      disabled={!isValidSolidity || !currentFilename || isVerifying || !selectedChainName}
                      aria-disabled={!isValidSolidity || !currentFilename || isVerifying || !selectedChainName}
                    />
                    <label className='ml-1' htmlFor='shouldRunVerificationChk'>Verify Contract</label>
                  </div>
                  : <>
                  </>
              }
            </div>
            )
          : (
            <p>No contracts ready for deployment yet, compile a solidity contract</p>
            )}
      </Container>
    </>
  )
}

export default Deployment
