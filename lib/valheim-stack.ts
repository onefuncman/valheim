import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ValheimServer } from './valheim';

export class ValheimStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ValheimServer(this, 'Valheim', { cpu: 4096, memoryLimitMiB: 8192, dnsConfig: { hostzedZone: "arn:aws:route53:::hostedzone/Z03299692N7Q40ZRFDKBD", domainName: "valheim.uphawk.systems" } });
  }
}
